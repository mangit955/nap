import { ScriptedLLMProvider } from "@nap/agent/testing/scripted-llm-provider";
import { InMemoryCapacityReconciler } from "@nap/db/testing/in-memory-capacity-reconciler";
import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemoryProjectSandboxStore } from "@nap/db/testing/in-memory-project-sandbox-store";
import { FAKE_OWNER, InMemoryProjectStore } from "@nap/db/testing/in-memory-project-store";
import { InMemorySandboxCapacity } from "@nap/db/testing/in-memory-sandbox-capacity";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { InMemorySnapshotStore } from "@nap/db/testing/in-memory-snapshot-store";
import { InMemoryTurnQueue } from "@nap/db/testing/in-memory-turn-queue";
import { InMemoryTurnRateLimiter } from "@nap/db/testing/in-memory-turn-rate-limiter";
import { InMemoryUserKeyStore } from "@nap/db/testing/in-memory-user-key-store";
import { TEMPLATE_DEV_PORT } from "@nap/sandbox/template";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import type { TurnRateLimiter } from "@nap/shared/ports/turn-rate-limit";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import type { WSEvents } from "hono/ws";
import { afterEach, describe, expect, it } from "vitest";
import { encryptionKeyFrom } from "./account/secret-box.ts";
import { composeNap, type NapDeps } from "./compose.ts";
import { createLogger } from "./logger.ts";

/**
 * The composition, assembled from nothing but fakes.
 *
 * This is the test the "one store and one bus per process" gotcha said did not exist: until
 * `composeNap` there was no way to build the whole system without a database, a sandbox
 * provider and a model account, so boot wiring was only ever proven by running it. What is
 * asserted here is deliberately shallow — every part has its own tests — and what matters is
 * that the wiring holds: the routes are mounted, they reach the stores they were given, and
 * the reaper sweeps.
 */

const CONFIG: NapDeps["config"] = {
  NAP_WEB_ORIGIN: "http://localhost:3000",
  NAP_MODEL: "openai/gpt-5.6-luna",
  NAP_FREE_MODEL: "openai/gpt-5.6-luna",
  NAP_ALLOWED_MODELS: ["openai/gpt-5.6-luna"],
  NAP_MAX_STEPS: 4,
  NAP_CONTEXT_BUDGET_TOKENS: 10_000,
  NAP_MAX_SANDBOXES_PER_USER: 2,
  NAP_FREE_MAX_SANDBOXES_PER_USER: 1,
  NAP_MAX_SANDBOXES_TOTAL: 10,
  NAP_SANDBOX_TTL_MINUTES: 30,
  NAP_REAP_IDLE_MINUTES: 10,
  NAP_REAP_INTERVAL_SECONDS: 60,
  NAP_JANITOR_INTERVAL_SECONDS: 60,
  NAP_WORKER_CONCURRENCY: 4,
};

/** 32 bytes of base64, which is all `encryptionKeyFrom` asks of it. */
const SECRET = Buffer.alloc(32, 7).toString("base64");

/** The routes validate the shape of an id before they look it up, so it has to be a real one. */
const PROJECT = "6f0a6f2c-2d2f-4a1e-9d31-6c9f2f0f4b21";

/** The one session that project holds, for the tests that run something in it. */
const SESSION = "9b2c1a30-4f5e-4c7a-8e1d-2b3c4d5e6f70";

const stopping: Array<{ stop: () => void | Promise<void> }> = [];

/**
 * A sandbox that answers the commands a turn really runs, git included.
 *
 * `InMemorySandboxManager` throws on anything nobody scripted, which is right for a test that is
 * about one command and wrong for one that drives a whole turn through the runtime.
 */
function turnableSandbox(): InMemorySandboxManager {
  return new InMemorySandboxManager({
    defaultExec: () => ({ exitCode: 0, stdout: "" }),
    serves: [TEMPLATE_DEV_PORT],
    seed: { [`${PROJECT_ROOT_PATH}/package.json`]: JSON.stringify({ scripts: {} }) },
  }).script(/git rev-parse HEAD/, { exitCode: 0, stdout: `${"0".repeat(40)}\n` });
}

/**
 * A model that answers in prose and asks for no tools, twice over.
 *
 * Two scripted turns because two requests are in flight: whichever of them continues a job runs a
 * turn of its own, and `ScriptedLLMProvider` throws past the end of its script rather than
 * inventing an answer.
 */
function chattyProvider(): ScriptedLLMProvider {
  return new ScriptedLLMProvider([[{ text: "Added the toggle." }], [{ text: "Nothing left." }]]);
}

afterEach(async () => {
  // A composition owns a timer and a claiming loop, so a test that forgets to stop them holds
  // the runner open.
  while (stopping.length > 0) await stopping.pop()?.stop();
});

function compose(overrides: Partial<NapDeps> = {}) {
  const composed = composeNap({
    config: CONFIG,
    logger: createLogger({ level: "silent" }, { write: () => {} }),
    sessions: new InMemorySessionStore(),
    projects: new InMemoryProjectStore(),
    queue: new InMemoryTurnQueue(),
    projectSandboxes: new InMemoryProjectSandboxStore(),
    capacity: new InMemorySandboxCapacity(),
    // Per-process limiters, which is exactly what a test wants and exactly what a deployment
    // must not have: one of these per replica is one allowance per replica.
    rateLimits: {
      rate: new InMemoryTurnRateLimiter({ limit: 15, windowMs: 60 * 60 * 1000 }),
      freeRate: new InMemoryTurnRateLimiter({ limit: 5, windowMs: 60 * 60 * 1000 }),
    },
    snapshots: new InMemorySnapshotStore(),
    userKeys: new InMemoryUserKeyStore(),
    events: new InMemoryEventStore(),
    bus: new InMemoryEventBus(),
    sandbox: new InMemorySandboxManager(),
    objects: new InMemoryObjectStore(),
    provider: new ScriptedLLMProvider([]),
    encryptionKey: encryptionKeyFrom(SECRET),
    verifyKey: async () => ({ ok: true }),
    createProject: async ({ userId }) => {
      const projectId = crypto.randomUUID();
      const sessionId = crypto.randomUUID();
      void userId;
      return { projectId, sessionId };
    },
    authenticate: async () => ({ userId: FAKE_OWNER, isAnonymous: false }),
    upgradeWebSocket: async (_c: unknown, _events: WSEvents) => new Response(null),
    ...overrides,
  });

  stopping.push(composed.reaper, composed.janitor, composed.worker);
  return composed;
}

describe("composeNap", () => {
  it("mounts the routes the API serves", async () => {
    const { app } = compose();

    const health = await app.request("/health");
    expect(health.status).toBe(200);

    // The two probe endpoints are the composition's, not boot's — a k8s manifest pointing at a
    // route only `index.ts` knows how to mount would be a deployment that fails on the kubelet's
    // first poll rather than in a test.
    expect((await app.request("/livez")).status).toBe(200);
    expect((await app.request("/readyz")).status).toBe(200);

    const projects = await app.request("/projects");
    expect(projects.status).toBe(200);
    await expect(projects.json()).resolves.toEqual({ projects: [] });
  });

  it("hands the readiness probe to /readyz, where a down database becomes a 503", async () => {
    // Wired separately from `health`, so this is the assertion that it is wired at all: a probe
    // built in boot and dropped on the floor here would look exactly like a healthy pod.
    const { app } = compose({
      readiness: async () => ({ status: "degraded", checks: { database: "down" } }),
    });

    expect((await app.request("/readyz")).status).toBe(503);
    // And the process is still alive, which is the whole reason the two are separate endpoints.
    expect((await app.request("/livez")).status).toBe(200);
  });

  it("reads and writes through the stores it was handed", async () => {
    const projects = new InMemoryProjectStore([
      {
        projectId: PROJECT,
        name: "a thing",
        status: "idle",
        sandboxId: null,
        updatedAt: new Date().toISOString(),
        sessionIds: ["session-1"],
      },
    ]);
    const { app } = compose({ projects });

    const listed = await app.request("/projects");
    const body = (await listed.json()) as { projects: Array<{ projectId: string }> };
    expect(body.projects.map((project) => project.projectId)).toEqual([PROJECT]);

    // One store reached the route that lists *and* the route that removes. Two would leave both
    // routes answering perfectly while the second one had no effect on the first.
    const deleted = await app.request(`/projects/${PROJECT}`, { method: "DELETE" });
    expect(deleted.status).toBe(200);

    const after = await app.request("/projects");
    await expect(after.json()).resolves.toEqual({ projects: [] });
  });

  it("still refuses a caller it cannot identify", async () => {
    // Composing with fakes must not compose away the gate in front of every route.
    const { app } = compose({ authenticate: async () => null });

    const res = await app.request("/projects");
    expect(res.status).toBe(401);
  });

  it("reconciles sandbox capacity on the same tick, when given the parts", async () => {
    // The wiring is the whole risk here: `reconcile` is optional, so a composition that dropped
    // it type-checks, boots, sweeps, and silently never puts a leaked slot back. Asserted on the
    // reconciler being *asked*, which is the one thing only the composition can get wrong.
    const reconcile = new InMemoryCapacityReconciler();

    compose({
      reconcile: { reconciler: reconcile, inventory: new InMemorySandboxManager() },
      config: { ...CONFIG, NAP_REAP_INTERVAL_SECONDS: 0.01 },
    });

    await expect.poll(() => reconcile.reclaimCalls(), { timeout: 2000 }).toBeGreaterThan(0);
  });

  it("sweeps both turn allowances on the same tick", async () => {
    // The rate window is rows in Postgres now, so something has to delete the ones that have
    // left it or the table keeps one per visitor forever. Both limiters, because each owns its
    // own tier's rows and a sweep of one says nothing about the other.
    const swept = { rate: 0, freeRate: 0 };
    const counting = (tally: "rate" | "freeRate"): TurnRateLimiter => ({
      check: async () => ({ allowed: true }),
      sweep: async () => {
        swept[tally] += 1;
        return 0;
      },
    });

    compose({
      rateLimits: { rate: counting("rate"), freeRate: counting("freeRate") },
      config: { ...CONFIG, NAP_REAP_INTERVAL_SECONDS: 0.01 },
    });

    await expect.poll(() => swept.rate, { timeout: 2000 }).toBeGreaterThan(0);
    expect(swept.freeRate).toBeGreaterThan(0);
  });

  it("serialises an open and a turn on one session, leaving the project one sandbox", async () => {
    // The failure this exists to prevent: a page that resumes on arrival while its user types a
    // message asks for both at once, and both create a sandbox when the project has none. Run in
    // parallel they each start one and the project ends up holding two — one of which nobody can
    // find and nobody stops paying for. Both are queued requests now, so the per-session lease
    // serialises them and the second finds the first one's sandbox.
    const sessions = new InMemorySessionStore([{ sessionId: SESSION, projectId: PROJECT }]);
    const projects = new InMemoryProjectStore([
      {
        projectId: PROJECT,
        name: "a thing",
        status: "idle",
        sandboxId: null,
        updatedAt: new Date().toISOString(),
        sessionIds: [SESSION],
      },
    ]);
    const queue = new InMemoryTurnQueue();
    const sandbox = turnableSandbox();
    const events = new InMemoryEventStore();
    const { app } = compose({
      sessions,
      projects,
      queue,
      sandbox,
      events,
      provider: chattyProvider(),
    });

    // Together, from one client, which is the whole point: neither request can see the other's
    // sandbox because at admission there isn't one.
    const [turn, open] = await Promise.all([
      app.request(`/sessions/${SESSION}/turns`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "add a dark mode toggle" }),
      }),
      app.request(`/projects/${PROJECT}/open`, { method: "POST" }),
    ]);

    expect(turn.status).toBe(202);
    expect(open.status).toBe(202);
    // Sorted, because which of the two admissions finishes first is not this test's subject —
    // that both were written down as requests rather than run in the request is.
    expect(queue.enqueued.map((request) => request.kind).sort()).toEqual(["resume", "turn"]);

    await expect.poll(() => queue.inFlight, { timeout: 10_000 }).toBe(0);

    // Both really ran, in some order — otherwise "one sandbox" would also be what a resume that
    // was silently dropped looks like. The open announced a preview, and the turn finished.
    const logged = (await events.readFrom(SESSION, 0)).map((event) => event.type);
    expect(logged).toContain("preview.ready");
    expect(logged).toContain("turn.completed");

    const live = await sandbox.list();
    expect(live.ok && live.value).toHaveLength(1);
  });

  it("sweeps a project nobody is using", async () => {
    const projectSandboxes = new InMemoryProjectSandboxStore([
      {
        projectId: "idle-project",
        sandboxId: "sandbox-1",
        sessionIds: ["session-1"],
        lastActiveAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      },
    ]);

    compose({
      projectSandboxes,
      // Fast enough that the test does not wait a minute for the first tick, which is the one
      // thing about the reaper this cannot take from the config.
      config: { ...CONFIG, NAP_REAP_INTERVAL_SECONDS: 0.01 },
    });

    await expect
      .poll(() => projectSandboxes.get("idle-project")?.sandboxId, { timeout: 2000 })
      .toBeNull();
  });
});
