import { ScriptedLLMProvider } from "@nap/agent/testing/scripted-llm-provider";
import { createDatabase } from "@nap/db/client";
import { PostgresAdvisoryLock } from "@nap/db/postgres-advisory-lock";
import { PostgresCancelChannel } from "@nap/db/postgres-cancel-channel";
import { PostgresEventStore } from "@nap/db/postgres-event-store";
import { PostgresNotifyTransport } from "@nap/db/postgres-notify-transport";
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
import { ControllableRuntime } from "@nap/runtime/testing/controllable-runtime";
import { startTurnWorker, type TurnWorker } from "@nap/runtime/turn-worker";
import { TEMPLATE_DEV_PORT } from "@nap/sandbox/template";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import { LEASE_RENEWAL_INTERVAL_MS } from "@nap/shared/lease-windows";
import type { LLMProvider, LLMRequest, LLMTurnResult } from "@nap/shared/ports/llm-provider";
import type { TurnQueue } from "@nap/shared/ports/turn-queue";
import type { TurnRateLimiter } from "@nap/shared/ports/turn-rate-limit";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { WSEvents } from "hono/ws";
import postgres from "postgres";
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
/** The reapers' lock connections: one each, and none of them from the pool. See `SweepLock`. */
const lockConnections: postgres.Sql[] = [];
/**
 * This run's suffix for the sweep lock's name.
 *
 * The container is shared across the `db` project, and an advisory lock is global to the database:
 * a fixed name would have this file contending with anything else that ever takes one.
 */
const run = crypto.randomUUID();
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
  // The locks go with them: a connection left open holds its advisory lock until the database
  // notices the socket is gone, and the next test would find the lock taken.
  for (const connection of lockConnections.splice(0)) await connection.end();
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
function pod(
  role: "api" | "worker" | "reaper",
  userId: string,
  overrides: Partial<NapDeps> = {},
): ComposedNap {
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
    cancels: null,
    sandbox: turnableSandbox(),
    objects: new InMemoryObjectStore(),
    provider: new ScriptedLLMProvider([[{ text: "Added the toggle." }]]),
    encryptionKey: encryptionKeyFrom(SECRET),
    verifyKey: async () => ({ ok: true }),
    createProject: async () => ({ projectId: crypto.randomUUID(), sessionId: crypto.randomUUID() }),
    authenticate: async () => ({ userId, isAnonymous: false }),
    upgradeWebSocket: async (_c: unknown, _events: WSEvents) => new Response(null),
    ...overrides,
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

  it("refuses to close a project a worker on another pod is running a turn in", async () => {
    // "Busy" has to mean one thing across the cluster, and this is the arrangement where a
    // per-process answer was wrong: the lease belongs to a worker the API pod has never heard of,
    // and closing the project would take the sandbox away mid-turn.
    const userId = await seedUser();
    const { projectId, sessionId } = await createProjectSession(db, { userId });

    const api = pod("api", userId);
    const elsewhere = new PostgresTurnQueue(db);
    await elsewhere.enqueue({
      id: crypto.randomUUID(),
      sessionId,
      userId,
      kind: "turn",
      message: "add a dark mode toggle",
      model: CONFIG.NAP_MODEL,
      billsToUser: false,
    });
    await elsewhere.claim("a-worker-on-another-pod");

    expect((await api.app.request(`/projects/${projectId}/close`, { method: "POST" })).status).toBe(
      409,
    );
    expect((await api.app.request(`/projects/${projectId}`, { method: "DELETE" })).status).toBe(
      409,
    );
  });

  it("lets exactly one of two reapers started together sweep", async () => {
    // What `replicas: 1` cannot promise on its own: a rolling update runs the new reaper while the
    // old one is still shutting down. Two real advisory locks over two connections, because that
    // is the whole mechanism — a lock taken through a pool would be held by a backend the holder
    // may never be handed again, and both processes would sweep.
    //
    // Counted through the rate-limit sweep, which is the first thing a tick does once it is past
    // the lock. This test deliberately reaps *no* project — the idle window is set beyond anything
    // in the shared container — because every db suite's rows are visible to `idleSince`.
    const userId = await seedUser();
    const ticks = [0, 0];
    const ticking = (which: number): TurnRateLimiter => ({
      check: async () => ({ allowed: true }),
      sweep: async () => {
        ticks[which] = (ticks[which] ?? 0) + 1;
        return 0;
      },
    });

    const config = { ...CONFIG, NAP_REAP_INTERVAL_SECONDS: 0.05, NAP_REAP_IDLE_MINUTES: 100_000 };
    for (const which of [0, 1]) {
      const connection = postgres(inject("postgresUrl"), { max: 1 });
      lockConnections.push(connection);
      pod("reaper", userId, {
        config,
        sweepLock: new PostgresAdvisoryLock(connection, `nap:split-test-sweep-${run}`),
        rateLimits: { rate: ticking(which), freeRate: ticking(which) },
      });
    }

    await expect.poll(() => Math.max(...ticks), { timeout: 5_000 }).toBeGreaterThan(1);
    // Several more intervals before asking about the loser. Asserting the moment the winner is
    // seen would pass whether or not the lock works, because the other process's first tick has
    // not landed yet — which is exactly how this test passed for the wrong reason once already.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(ticks.filter((count) => count === 0)).toHaveLength(1);
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

/**
 * A model that keeps streaming until its signal fires, which is what a cancel is for.
 *
 * It records when the signal arrived, so a test measures the thing somebody pays for: how long a
 * model went on running after they pressed stop. Only for the prompt it was told to hold: the
 * container is shared, so a worker here may also claim what an earlier test left queued, and those
 * answer at once rather than occupying the turn being measured.
 */
class StreamingUntilAborted implements LLMProvider {
  calls = 0;
  abortedAt: number | null = null;
  readonly #prompt: string;

  constructor(prompt: string) {
    this.#prompt = prompt;
  }

  startTurn() {
    return {
      usage: () => ({ inputTokens: 0, outputTokens: 0 }),
      complete: (request: LLMRequest) =>
        new Promise<LLMTurnResult>((resolve, reject) => {
          if (!JSON.stringify(request.messages).includes(this.#prompt)) {
            const usage = { inputTokens: 0, outputTokens: 0 };
            resolve({ type: "message", text: "Nothing to do.", toolCalls: [], usage });
            return;
          }
          this.calls += 1;
          request.signal?.addEventListener("abort", () => {
            this.abortedAt = Date.now();
            reject(request.signal?.reason);
          });
        }),
    };
  }
}

/**
 * One pod's end of the channel: its own pool and its own listener, as `bootNap` builds them.
 *
 * `dropping` is a pod whose `pg_notify` goes nowhere while everything else about it is fine, which
 * is what a lost wake-up looks like from both sides.
 */
function channelOf(options: { dropping?: boolean } = {}) {
  const notifier = postgres(inject("postgresUrl"), { max: 2 });
  const listener = postgres(inject("postgresUrl"), { max: 1 });
  lockConnections.push(notifier, listener);
  const transport = new PostgresNotifyTransport({ notifier, listener });
  return new PostgresCancelChannel(
    options.dropping === true
      ? { notify: async () => {}, listen: (channel, handler) => transport.listen(channel, handler) }
      : transport,
  );
}

describe("a cancel crossing from an API pod to a worker pod", () => {
  it("stops the model well inside one renewal interval", async () => {
    const userId = await seedUser();
    const { sessionId } = await createProjectSession(db, { userId });
    const prompt = `add a dark mode toggle, ${crypto.randomUUID()}`;
    const provider = new StreamingUntilAborted(prompt);

    const api = pod("api", userId, { cancels: channelOf() });
    pod("worker", userId, { provider, cancels: channelOf() });

    const accepted = await api.app.request(`/sessions/${sessionId}/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: prompt }),
    });
    expect(accepted.status).toBe(202);
    await expect.poll(() => provider.calls, { timeout: 20_000 }).toBe(1);

    const pressedAt = Date.now();
    const cancelled = await api.app.request(`/sessions/${sessionId}/turns/cancel`, {
      method: "POST",
    });
    expect(cancelled.status).toBe(202);

    // Waited for past the renewal, so a regression reads as the number it is rather than a timeout.
    await expect
      .poll(() => provider.abortedAt, { timeout: LEASE_RENEWAL_INTERVAL_MS + 5_000, interval: 5 })
      .not.toBeNull();
    expect((provider.abortedAt ?? 0) - pressedAt).toBeLessThan(LEASE_RENEWAL_INTERVAL_MS / 10);

    // And it ended as a cancelled turn, in the log an API pod reads, rather than merely stopping.
    const log = new PostgresEventStore(db);
    await expect
      .poll(
        async () =>
          (await log.readFrom(sessionId, 0)).find((event) => event.type === "turn.failed")?.payload,
        { timeout: 10_000 },
      )
      .toMatchObject({ reason: "cancelled" });
  }, 60_000);
});

/**
 * The worker against the real queue and a real channel, with the runtime's turn held open.
 *
 * Below the composition, because what varies here is the renewal interval, and that is not a thing
 * a deployment gets to turn: fifteen seconds of waiting per test would prove nothing further.
 */
describe("a worker and a real channel over one database", () => {
  const workers: { worker: TurnWorker; runtime: ControllableRuntime }[] = [];

  afterEach(async () => {
    for (const { worker, runtime } of workers.splice(0)) {
      runtime.complete();
      await worker.stop();
    }
  });

  /** Claims only the request it is told to, because the container is shared with other tests. */
  function workerOf(options: { sessionId: string; renewIntervalMs: number }) {
    const queue = new PostgresTurnQueue(db);
    const runtime = new ControllableRuntime();
    const worker = startTurnWorker({
      queue: {
        ...queueMethods(queue),
        claim: async (owner) => {
          const next = await queue.claim(owner);
          if (next !== null && next.sessionId !== options.sessionId) {
            await queue.settle(next.id, owner, "failed");
            return null;
          }
          return next;
        },
      },
      runtime,
      concurrency: 1,
      pollIntervalMs: 20,
      renewIntervalMs: options.renewIntervalMs,
      cancels: channelOf(),
    });
    workers.push({ worker, runtime });
    return runtime;
  }

  async function admitted(sessionId: string, userId: string): Promise<string> {
    const id = crypto.randomUUID();
    await new PostgresTurnQueue(db).enqueue({
      id,
      sessionId,
      userId,
      kind: "turn",
      message: "add a dark mode toggle",
      model: CONFIG.NAP_MODEL,
      billsToUser: false,
    });
    return id;
  }

  async function runningIn(runtime: ControllableRuntime, count = 1): Promise<AbortSignal> {
    await expect.poll(() => runtime.requests.length, { timeout: 10_000 }).toBe(count);
    const signal = runtime.signal;
    if (signal === undefined) throw new Error("the runtime was given no signal");
    return signal;
  }

  it("still cancels at the next renewal when the notification is lost", async () => {
    const userId = await seedUser();
    const { sessionId } = await createProjectSession(db, { userId });
    const runtime = workerOf({ sessionId, renewIntervalMs: 400 });
    await admitted(sessionId, userId);
    const signal = await runningIn(runtime);

    const outcome = await new PostgresTurnQueue(db).requestCancel(sessionId);
    if (!outcome.cancelled || outcome.was !== "leased") throw new Error("expected a leased row");
    channelOf({ dropping: true }).announce(outcome.requestId);

    expect(signal.aborted).toBe(false);
    await expect.poll(() => signal.aborted, { timeout: 5_000 }).toBe(true);
    expect(signal.reason).toMatchObject({ code: "cancelled" });
  }, 30_000);

  it("stops nothing when told about a request whose row was never flagged", async () => {
    const userId = await seedUser();
    const { sessionId } = await createProjectSession(db, { userId });
    const runtime = workerOf({ sessionId, renewIntervalMs: 600_000 });
    const id = await admitted(sessionId, userId);
    const signal = await runningIn(runtime);

    const api = channelOf();
    api.announce(id);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(signal.aborted).toBe(false);

    // The other half, without which the wait above could be a channel that was never working.
    await new PostgresTurnQueue(db).requestCancel(sessionId);
    api.announce(id);
    await expect.poll(() => signal.aborted, { timeout: 2_000, interval: 5 }).toBe(true);
  }, 30_000);

  it("leaves a session's next turn alone when one arrives late for its last", async () => {
    const userId = await seedUser();
    const { sessionId } = await createProjectSession(db, { userId });
    const runtime = workerOf({ sessionId, renewIntervalMs: 600_000 });
    const queue = new PostgresTurnQueue(db);
    const first = await admitted(sessionId, userId);
    await runningIn(runtime);
    runtime.complete();
    await expect.poll(() => queue.hasPending(sessionId), { timeout: 5_000 }).toBe(false);

    const second = await admitted(sessionId, userId);
    const signal = await runningIn(runtime, 2);

    const api = channelOf();
    api.announce(first);
    api.announce(crypto.randomUUID());
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(signal.aborted).toBe(false);

    await queue.requestCancel(sessionId);
    api.announce(second);
    await expect.poll(() => signal.aborted, { timeout: 2_000, interval: 5 }).toBe(true);
  }, 30_000);
});

/** Delegated one by one, because these are class methods over private fields. */
function queueMethods(queue: PostgresTurnQueue): TurnQueue {
  return {
    enqueue: (request) => queue.enqueue(request),
    getStatus: (request) => queue.getStatus(request),
    hasPending: (sessionId) => queue.hasPending(sessionId),
    claim: (owner) => queue.claim(owner),
    renew: (requestId, owner) => queue.renew(requestId, owner),
    settle: (requestId, owner, state) => queue.settle(requestId, owner, state),
    requestCancel: (sessionId) => queue.requestCancel(sessionId),
    anyLeased: (sessionIds) => queue.anyLeased(sessionIds),
    orphanExpired: (limit) => queue.orphanExpired(limit),
    unannouncedOrphans: (limit) => queue.unannouncedOrphans(limit),
    markOrphanAnnounced: (requestId) => queue.markOrphanAnnounced(requestId),
  };
}
