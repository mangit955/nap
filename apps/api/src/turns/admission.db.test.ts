/**
 * What accepting a turn costs the database, and that the refusals it makes still hold.
 *
 * The API is composed from the stores boot gives it, against a real Postgres and a real sign-in,
 * with one client underneath everything so its `debug` hook sees every statement the request
 * waits on: the auth library's, the route's and the queue's. Counting statements rather than
 * timing them, because a count is deterministic and every statement is a round trip to a database
 * on another machine.
 *
 * Two things boot composes are left out, and the count does not cover them. The queue announces a
 * claim wake-up after the enqueue, and a project's first prompt starts generating its title; boot
 * wires both, and both send statements of their own. Neither is awaited by the request, so neither
 * delays the 202, and composing them would make the count depend on how far a detached task had
 * got when it was read.
 *
 * The refusals are here as well as in `routes.test.ts`, which proves them against fakes, because
 * the rate limiter's count and insert are SQL: whether a refused attempt leaves the allowance
 * untouched is the database's answer, and a fake would agree with itself about it.
 *
 * The container is shared across the `db` project, so every user is fresh and the sandbox ceiling
 * is either far above anything the suite creates or zero, never a number the suite could reach.
 */

import { ScriptedLLMProvider } from "@nap/agent/testing/scripted-llm-provider";
import { PostgresEventStore } from "@nap/db/postgres-event-store";
import { PostgresProjectSandboxStore } from "@nap/db/postgres-project-sandbox-store";
import { PostgresProjectStore } from "@nap/db/postgres-project-store";
import { PostgresSandboxCapacity } from "@nap/db/postgres-sandbox-capacity";
import { PostgresSessionStore } from "@nap/db/postgres-session-store";
import { PostgresSnapshotStore } from "@nap/db/postgres-snapshot-store";
import { PostgresTurnQueue } from "@nap/db/postgres-turn-queue";
import { PostgresTurnRateLimiter } from "@nap/db/postgres-turn-rate-limiter";
import { PostgresUserKeyStore } from "@nap/db/postgres-user-key-store";
import { projects, turnRateEvents, turnRequests, users } from "@nap/db/schema";
import { createProjectSession } from "@nap/db/session-bootstrap";
// Type-only: brings in the augmentation that types `inject("postgresUrl")`.
import type {} from "@nap/db/testing/global-setup";
import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { and, eq } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { WSEvents } from "hono/ws";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { encryptionKeyFrom } from "../account/secret-box.ts";
import { createAuth } from "../auth/auth.ts";
import { type ComposedNap, composeNap, type NapDeps } from "../compose.ts";
import { createLogger } from "../logger.ts";

const API_ORIGIN = "http://localhost:3001";
const WEB_ORIGIN = "http://localhost:3000";
const MODEL = "openai/gpt-5.6-luna";
const HOUR_MS = 60 * 60 * 1000;

/**
 * The most statements accepting one turn may send, auth included, for the two shapes a turn
 * arrives in. A project's first turn is the expensive one: nothing serves it yet, so the sandbox
 * quota is counted, and it still has its placeholder name, so it is named. A reply in a
 * conversation already under way skips both.
 *
 * A first turn, in the order the database sees them:
 *
 *   2  the auth library: the sign-in session by its token, then its user
 *   2  the session-and-project join, and the caller's stored key, sent together
 *   1  both sandbox counts, this person's and everybody's
 *   4  the rate limiter: begin, its lock, the count-and-record, commit
 *   2  naming the project, and the enqueue, sent together
 *
 * Eleven statements in nine round trips, where it was fourteen in fourteen. A follow-up is nine in
 * eight. These are auth plus what admission awaits; the claim announcement after the enqueue and a
 * first prompt's title generation are detached, not composed here, and not counted. Raising either
 * number means a statement was added to the path every prompt waits on.
 */
const FIRST_TURN_STATEMENTS = 11;
const FOLLOW_UP_STATEMENTS = 9;

let client: postgres.Sql;
let db: PostgresJsDatabase;
let sent: string[] = [];

beforeAll(() => {
  client = postgres(inject("postgresUrl"), {
    max: 8,
    debug: (_connection, query) => sent.push(query),
  });
  db = drizzle(client);
});

afterAll(async () => {
  await client.end();
});

const CONFIG: NapDeps["config"] = {
  NAP_WEB_ORIGIN: WEB_ORIGIN,
  NAP_MODEL: MODEL,
  NAP_FREE_MODEL: MODEL,
  NAP_ALLOWED_MODELS: [MODEL],
  NAP_MAX_STEPS: 4,
  NAP_CONTEXT_BUDGET_TOKENS: 10_000,
  NAP_MAX_SANDBOXES_PER_USER: 4,
  NAP_FREE_MAX_SANDBOXES_PER_USER: 1,
  NAP_MAX_SANDBOXES_TOTAL: 100_000,
  NAP_SANDBOX_TTL_MINUTES: 30,
  NAP_REAP_IDLE_MINUTES: 60,
  NAP_VIEWER_KEEP_WARM_MINUTES: 120,
  NAP_REAP_INTERVAL_SECONDS: 3600,
  NAP_JANITOR_INTERVAL_SECONDS: 3600,
  NAP_WORKER_CONCURRENCY: 2,
  NAP_WORKER_FALLBACK_POLL_SECONDS: 5,
  NAP_DRAIN_TIMEOUT_SECONDS: 5,
  NAP_CAPTURE_CONCURRENCY: 1,
};

const SECRET = Buffer.alloc(32, 7).toString("base64");

/**
 * An API pod built from boot's stores: real auth, real stores, nothing started. Unlike boot it
 * announces no claims and generates no titles — see the top of this file.
 */
function apiPod(
  options: { freeTurnsPerHour?: number; config?: Partial<NapDeps["config"]> } = {},
): ComposedNap {
  const auth = createAuth(db, {
    secret: "a-test-secret-that-is-long-enough-to-be-a-secret",
    baseUrl: API_ORIGIN,
    webOrigin: WEB_ORIGIN,
    allowAnonymous: false,
  });
  return composeNap({
    config: { ...CONFIG, ...options.config },
    role: "api",
    logger: createLogger({ level: "silent" }, { write: () => {} }),
    sessions: new PostgresSessionStore(db),
    projects: new PostgresProjectStore(db),
    projectSandboxes: new PostgresProjectSandboxStore(db),
    capacity: new PostgresSandboxCapacity(db, { perUser: 4, total: 100_000 }),
    rateLimits: {
      rate: new PostgresTurnRateLimiter(db, { limit: 500, windowMs: HOUR_MS, tier: "paid" }),
      freeRate: new PostgresTurnRateLimiter(db, {
        limit: options.freeTurnsPerHour ?? 500,
        windowMs: HOUR_MS,
        tier: "free",
      }),
    },
    queue: new PostgresTurnQueue(db, { claims: null }),
    snapshots: new PostgresSnapshotStore(db),
    userKeys: new PostgresUserKeyStore(db),
    events: new PostgresEventStore(db),
    bus: new InMemoryEventBus(),
    cancels: null,
    claims: null,
    sandbox: new InMemorySandboxManager(),
    objects: new InMemoryObjectStore(),
    provider: new ScriptedLLMProvider([]),
    encryptionKey: encryptionKeyFrom(SECRET),
    verifyKey: async () => ({ ok: true }),
    createProject: async () => ({ projectId: crypto.randomUUID(), sessionId: crypto.randomUUID() }),
    auth,
    authenticate: auth.getUser,
    upgradeWebSocket: async (_c: unknown, _events: WSEvents) => new Response(null),
  });
}

/** Signs a fresh person up and hands back their cookie and id. */
async function signedUp(pod: ComposedNap): Promise<{ cookie: string; userId: string }> {
  const email = `admission-${crypto.randomUUID()}@example.com`;
  const response = await pod.app.request(`${API_ORIGIN}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: WEB_ORIGIN },
    body: JSON.stringify({ email, password: "correct horse battery staple", name: "Ada" }),
  });
  expect(response.status).toBe(200);
  const cookie = response.headers
    .getSetCookie()
    .map((one) => one.split(";")[0])
    .join("; ");
  const [user] = await db.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (user === undefined) throw new Error("sign-up wrote no user");
  return { cookie, userId: user.id };
}

async function postTurn(
  pod: ComposedNap,
  sessionId: string,
  cookie: string | undefined,
): Promise<Response> {
  return await pod.app.request(`${API_ORIGIN}/sessions/${sessionId}/turns`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: WEB_ORIGIN,
      ...(cookie === undefined ? {} : { cookie }),
    },
    body: JSON.stringify({ message: "build a habit tracker" }),
  });
}

/**
 * The statements one request sent, and the request's response.
 *
 * Less the driver's array-type lookup, which postgres.js sends once on every connection it opens:
 * it is a property of how warm the pool is, not of the request, and a request that happens to be
 * the first to need a second connection would otherwise count one statement it never asked for.
 */
async function counted(request: () => Promise<Response>): Promise<[Response, string[]]> {
  sent = [];
  const response = await request();
  const mine = sent.filter((query) => !query.includes("pg_catalog.pg_type"));
  sent = [];
  return [response, mine];
}

async function rateEvents(userId: string): Promise<number> {
  const rows = await db
    .select({ id: turnRateEvents.userId })
    .from(turnRateEvents)
    .where(eq(turnRateEvents.userId, userId));
  return rows.length;
}

async function queuedFor(sessionId: string): Promise<number> {
  const rows = await db
    .select({ id: turnRequests.id })
    .from(turnRequests)
    .where(and(eq(turnRequests.sessionId, sessionId), eq(turnRequests.state, "queued")));
  return rows.length;
}

describe("what accepting a turn costs", () => {
  it("a project's first turn sends at most a bounded number of statements", async () => {
    const pod = apiPod();
    const { cookie, userId } = await signedUp(pod);
    const { sessionId } = await createProjectSession(db, { userId });

    const [response, statements] = await counted(() => postTurn(pod, sessionId, cookie));

    expect(response.status).toBe(202);
    expect(statements.length, statements.join("\n")).toBeLessThanOrEqual(FIRST_TURN_STATEMENTS);
  });

  it("a reply in a project that already has a sandbox sends fewer", async () => {
    const pod = apiPod();
    const { cookie, userId } = await signedUp(pod);
    const { projectId, sessionId } = await createProjectSession(db, {
      userId,
      name: "Habit tracker",
    });
    await db
      .update(projects)
      .set({ sandboxId: `sbx-${crypto.randomUUID()}` })
      .where(eq(projects.id, projectId));

    const [response, statements] = await counted(() => postTurn(pod, sessionId, cookie));

    expect(response.status).toBe(202);
    expect(statements.length, statements.join("\n")).toBeLessThanOrEqual(FOLLOW_UP_STATEMENTS);
  });
});

describe("what accepting a turn still refuses", () => {
  it("refuses a caller with no session, before reading anything of theirs", async () => {
    const pod = apiPod();
    const { userId } = await signedUp(pod);
    const { sessionId } = await createProjectSession(db, { userId });

    expect((await postTurn(pod, sessionId, undefined)).status).toBe(401);
    expect((await postTurn(pod, sessionId, "better-auth.session_token=forged")).status).toBe(401);
    expect(await queuedFor(sessionId)).toBe(0);
    expect(await rateEvents(userId)).toBe(0);
  });

  it("answers somebody else's session exactly as one that does not exist", async () => {
    const pod = apiPod();
    const owner = await signedUp(pod);
    const stranger = await signedUp(pod);
    const { sessionId } = await createProjectSession(db, { userId: owner.userId });

    const theirs = await postTurn(pod, sessionId, stranger.cookie);
    const nobodys = await postTurn(pod, crypto.randomUUID(), stranger.cookie);

    expect(theirs.status).toBe(404);
    expect(await theirs.json()).toEqual(await nobodys.json());
    expect(await queuedFor(sessionId)).toBe(0);
    expect(await rateEvents(stranger.userId)).toBe(0);
  });

  it("refuses a caller at their own sandbox limit with a 409, and spends none of their allowance", async () => {
    const pod = apiPod();
    const { cookie, userId } = await signedUp(pod);
    // The free tier's limit is one, and this project holds it.
    const running = await createProjectSession(db, { userId, name: "running" });
    await db
      .update(projects)
      .set({ sandboxId: `sbx-${crypto.randomUUID()}` })
      .where(eq(projects.id, running.projectId));
    const { sessionId } = await createProjectSession(db, { userId });

    const refused = await postTurn(pod, sessionId, cookie);

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ code: "sandbox_quota_exceeded" });
    expect(refused.headers.get("retry-after")).toBeNull();
    expect(await rateEvents(userId)).toBe(0);
    expect(await queuedFor(sessionId)).toBe(0);
    // The project that already has its sandbox is not refused: the cap is on sandboxes, not on
    // conversations.
    expect((await postTurn(pod, running.sessionId, cookie)).status).toBe(202);
  });

  it("refuses at the server-wide ceiling with a 409 that says so", async () => {
    const pod = apiPod({ config: { NAP_MAX_SANDBOXES_TOTAL: 0 } });
    const { cookie, userId } = await signedUp(pod);
    const { sessionId } = await createProjectSession(db, { userId });

    const refused = await postTurn(pod, sessionId, cookie);

    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      code: "sandbox_quota_exceeded",
      error: expect.stringContaining("This server is at its limit"),
    });
    expect(await rateEvents(userId)).toBe(0);
  });

  it("refuses past the hourly allowance with a 429 and a Retry-After, and records only what it accepted", async () => {
    const pod = apiPod({ freeTurnsPerHour: 2 });
    const { cookie, userId } = await signedUp(pod);
    const { sessionId } = await createProjectSession(db, { userId });

    expect((await postTurn(pod, sessionId, cookie)).status).toBe(202);
    expect((await postTurn(pod, sessionId, cookie)).status).toBe(202);
    const refused = await postTurn(pod, sessionId, cookie);

    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ code: "rate_limited" });
    const wait = Number(refused.headers.get("retry-after"));
    expect(wait).toBeGreaterThan(3500);
    expect(wait).toBeLessThanOrEqual(3600);
    expect(await rateEvents(userId)).toBe(2);
    expect(await queuedFor(sessionId)).toBe(2);
  });
});
