import { ScriptedLLMProvider } from "@nap/agent/testing/scripted-llm-provider";
import { createDatabase } from "@nap/db/client";
import { PostgresEventStore } from "@nap/db/postgres-event-store";
import { PostgresProjectSandboxStore } from "@nap/db/postgres-project-sandbox-store";
import { PostgresProjectStore } from "@nap/db/postgres-project-store";
import { PostgresSandboxCapacity } from "@nap/db/postgres-sandbox-capacity";
import { PostgresSessionStore } from "@nap/db/postgres-session-store";
import { PostgresSnapshotStore } from "@nap/db/postgres-snapshot-store";
import { PostgresTurnQueue } from "@nap/db/postgres-turn-queue";
import { PostgresTurnRateLimiter } from "@nap/db/postgres-turn-rate-limiter";
import { PostgresUserKeyStore } from "@nap/db/postgres-user-key-store";
import { users } from "@nap/db/schema";
import { createProjectSession } from "@nap/db/session-bootstrap";
import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { TEMPLATE_DEV_PORT } from "@nap/sandbox/template";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { WSEvents } from "hono/ws";
import { afterAll, afterEach, beforeAll, describe, expect, inject, it } from "vitest";
import { encryptionKeyFrom } from "./account/secret-box.ts";
import { type ComposedNap, composeNap, type NapDeps } from "./compose.ts";
import { createLogger } from "./logger.ts";

/**
 * The two halves of the deployment, in two compositions, against one real database.
 *
 * `compose.test.ts` proves the roles gate what they should, but it does it against an in-memory
 * queue — which cannot tell the difference between "the worker claimed a row" and "the worker
 * happened to be handed the same object". The thing worth being sure of is the one this ticket is
 * about: an API pod that writes a row and goes back to serving, and a *different* composition that
 * finds that row in Postgres and runs it.
 *
 * So the two share their stores' *database* and share nothing in this process. Each gets its own
 * bus, its own registry, its own sandbox provider and its own store instances, which is what a
 * pair of pods has. Anything that quietly depended on them being one process fails here.
 *
 * The infrastructure below Postgres is still fake — a sandbox that answers exec, a model that
 * answers prose — because what is under test is the handoff and not E2B.
 */

const stopping: ComposedNap[] = [];
let db: PostgresJsDatabase;
let close: () => Promise<void>;

beforeAll(() => {
  const opened = createDatabase(inject("postgresUrl"), { max: 8 });
  db = opened.db;
  close = opened.close;
});

/**
 * Between tests, not at the end of the file: a worker left claiming would pick up the *next*
 * test's request, which is precisely how the "nobody claimed it" assertion below would pass for
 * the wrong reason — or, worse, fail for one.
 */
afterEach(async () => {
  for (const composed of stopping.splice(0)) {
    composed.reaper.stop();
    composed.janitor.stop();
    await composed.worker.stop();
  }
});

afterAll(async () => {
  await close();
});

const CONFIG: NapDeps["config"] = {
  NAP_WEB_ORIGIN: "http://localhost:3000",
  NAP_MODEL: "openai/gpt-5.6-luna",
  NAP_FREE_MODEL: "openai/gpt-5.6-luna",
  NAP_ALLOWED_MODELS: ["openai/gpt-5.6-luna"],
  NAP_MAX_STEPS: 4,
  NAP_CONTEXT_BUDGET_TOKENS: 10_000,
  NAP_MAX_SANDBOXES_PER_USER: 4,
  NAP_FREE_MAX_SANDBOXES_PER_USER: 4,
  NAP_MAX_SANDBOXES_TOTAL: 40,
  NAP_SANDBOX_TTL_MINUTES: 30,
  // Long enough that neither sweep runs during the test: this is about the queue, and a reaper
  // taking the sandbox away mid-turn would be a different test failing.
  NAP_REAP_IDLE_MINUTES: 60,
  NAP_REAP_INTERVAL_SECONDS: 3600,
  NAP_JANITOR_INTERVAL_SECONDS: 3600,
  NAP_WORKER_CONCURRENCY: 2,
  NAP_DRAIN_TIMEOUT_SECONDS: 5,
  NAP_CAPTURE_CONCURRENCY: 1,
};

/** 32 bytes of base64, which is all `encryptionKeyFrom` asks of it. */
const SECRET = Buffer.alloc(32, 7).toString("base64");

const TURN_WINDOW_MS = 60 * 60 * 1000;

async function seedUser(): Promise<string> {
  const [user] = await db
    .insert(users)
    .values({ email: `${crypto.randomUUID()}@example.com`, name: "Ada" })
    .returning();
  return user?.id ?? "";
}

/** A sandbox that answers the commands a turn really runs, git included. */
function turnableSandbox(): InMemorySandboxManager {
  return new InMemorySandboxManager({
    defaultExec: () => ({ exitCode: 0, stdout: "" }),
    serves: [TEMPLATE_DEV_PORT],
    seed: { [`${PROJECT_ROOT_PATH}/package.json`]: JSON.stringify({ scripts: {} }) },
  }).script(/git rev-parse HEAD/, { exitCode: 0, stdout: `${"0".repeat(40)}\n` });
}

/**
 * One pod: every store built fresh over the shared database, and nothing in memory shared.
 *
 * The duplication is the point — two pods really do each construct their own of all of these, and
 * a helper that handed the same instances to both would be testing the arrangement this ticket
 * exists to stop being.
 */
function pod(role: "api" | "worker", userId: string): ComposedNap {
  const composed = composeNap({
    config: CONFIG,
    role,
    logger: createLogger({ level: "silent" }, { write: () => {} }),
    sessions: new PostgresSessionStore(db),
    projects: new PostgresProjectStore(db),
    projectSandboxes: new PostgresProjectSandboxStore(db),
    capacity: new PostgresSandboxCapacity(db, { perUser: 4, total: 40 }),
    rateLimits: {
      rate: new PostgresTurnRateLimiter(db, { limit: 500, windowMs: TURN_WINDOW_MS, tier: "paid" }),
      freeRate: new PostgresTurnRateLimiter(db, {
        limit: 500,
        windowMs: TURN_WINDOW_MS,
        tier: "free",
      }),
    },
    // The one thing the two pods share, and the only thing they may.
    queue: new PostgresTurnQueue(db),
    snapshots: new PostgresSnapshotStore(db),
    userKeys: new PostgresUserKeyStore(db),
    events: new PostgresEventStore(db),
    // Per pod, deliberately: an in-process bus is exactly what a split deployment must not rely
    // on, so giving each its own is how this test refuses to be passed by fanout.
    bus: new InMemoryEventBus(),
    sandbox: turnableSandbox(),
    objects: new InMemoryObjectStore(),
    provider: new ScriptedLLMProvider([[{ text: "Added the toggle." }]]),
    encryptionKey: encryptionKeyFrom(SECRET),
    verifyKey: async () => ({ ok: true }),
    createProject: async () => ({ projectId: crypto.randomUUID(), sessionId: crypto.randomUUID() }),
    authenticate: async () => ({ userId, isAnonymous: false }),
    upgradeWebSocket: async (_c: unknown, _events: WSEvents) => new Response(null),
  });

  stopping.push(composed);
  return composed;
}

describe("an API pod and a worker pod over one database", () => {
  it("runs a turn the API only wrote down", async () => {
    const userId = await seedUser();
    const { sessionId } = await createProjectSession(db, { userId });

    const api = pod("api", userId);
    pod("worker", userId);

    const accepted = await api.app.request(`/sessions/${sessionId}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "add a dark mode toggle" }),
    });
    expect(accepted.status).toBe(202);

    // Read back through the API's own store, which is a different instance from the one the
    // worker appended through: the log in Postgres is the whole of what connects them.
    const log = new PostgresEventStore(db);
    await expect
      .poll(async () => (await log.readFrom(sessionId, 0)).map((event) => event.type), {
        timeout: 20_000,
        interval: 200,
      })
      .toContain("turn.completed");
  });

  it("leaves the request queued when no worker is composed beside it", async () => {
    // The other half of the same claim. Without this, an API that had quietly kept its worker
    // would pass the test above and nothing would say so.
    const userId = await seedUser();
    const { sessionId } = await createProjectSession(db, { userId });

    const api = pod("api", userId);
    const accepted = await api.app.request(`/sessions/${sessionId}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "add a dark mode toggle" }),
    });
    expect(accepted.status).toBe(202);

    // Long enough for many poll intervals of a worker that is not there.
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const log = new PostgresEventStore(db);
    expect(await log.readFrom(sessionId, 0)).toEqual([]);
  });
});
