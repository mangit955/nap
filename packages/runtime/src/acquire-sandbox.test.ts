import { InMemorySandboxCapacity } from "@nap/db/testing/in-memory-sandbox-capacity";
import { InMemorySessionStore } from "@nap/db/testing/in-memory-session-store";
import { InMemorySnapshotStore } from "@nap/db/testing/in-memory-snapshot-store";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import type { SandboxManager } from "@nap/shared/ports/sandbox-manager";
import type { SessionRecord } from "@nap/shared/ports/session-store";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { describe, expect, it } from "vitest";
import { acquireSandbox, LOST_SANDBOX_WARNING } from "./acquire-sandbox.ts";

/**
 * Getting a sandbox to work in — the first step of every turn and every resume, and the one with
 * the most ways to go sideways.
 *
 * Four paths through it and each was previously reachable only by booting a whole runtime and
 * calling `runTurn`, which is why the interesting one had no test at all: a *recorded* sandbox
 * that will not resume. That is survivable only because a snapshot can be restored into a new
 * one, and the user has to be told, because everything since the last snapshot is genuinely gone.
 */

const SESSION_ID = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";
const PROJECT_ID = "4d5e6f70-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const USER_ID = "8f0a1b2c-3d4e-4f50-9a6b-7c8d9e0f1a2b";
const TTL_MS = 30 * 60 * 1000;

function session(sandboxId: string | null): SessionRecord {
  return { sessionId: SESSION_ID, projectId: PROJECT_ID, userId: USER_ID, sandboxId };
}

function deps(sandbox: SandboxManager, options: { restore?: boolean } = {}) {
  const sessions = new InMemorySessionStore([{ sessionId: SESSION_ID, projectId: PROJECT_ID }]);
  const restore = options.restore
    ? { objects: new InMemoryObjectStore(), snapshots: new InMemorySnapshotStore() }
    : null;

  return { sandbox, sessions, restore, ttlMs: TTL_MS };
}

/**
 * A manager with one method watched or replaced.
 *
 * Bound method by method rather than `Object.create`: the fake keeps its state in private fields,
 * and a delegate whose prototype is the instance fails on the first access with "Receiver must be
 * an instance of". Every method is bound to the original, so the copy shares its sandboxes.
 *
 * **No cast.** An earlier version asserted the shape with `as unknown as SandboxManager`, which
 * would have let the port grow an eleventh method and leave this fake handing back `undefined` at
 * runtime. Written this way, that fails to compile here instead.
 */
function wrap(manager: InMemorySandboxManager, over: Partial<SandboxManager>): SandboxManager {
  const bound: SandboxManager = {
    create: (projectId) => manager.create(projectId),
    resume: (sandboxId) => manager.resume(sandboxId),
    destroy: (sandboxId) => manager.destroy(sandboxId),
    extendTimeout: (sandboxId, ms) => manager.extendTimeout(sandboxId, ms),
    writeFile: (sandboxId, path, contents) => manager.writeFile(sandboxId, path, contents),
    readFile: (sandboxId, path) => manager.readFile(sandboxId, path),
    listFiles: (sandboxId, options) => manager.listFiles(sandboxId, options),
    exec: (sandboxId, command, options) => manager.exec(sandboxId, command, options),
    getPreviewUrl: (sandboxId, port) => manager.getPreviewUrl(sandboxId, port),
    waitForPreview: (sandboxId, port, options) => manager.waitForPreview(sandboxId, port, options),
  };

  return { ...bound, ...over };
}

/** Records the keepalive, which is the one call here whose result is deliberately ignored. */
function withExtendRecorder(manager: InMemorySandboxManager) {
  const extended: { id: string; ms: number }[] = [];
  const extendTimeout = manager.extendTimeout.bind(manager);

  return {
    extended,
    sandbox: wrap(manager, {
      extendTimeout: async (id: string, ms: number) => {
        extended.push({ id, ms });
        return await extendTimeout(id, ms);
      },
    }),
  };
}

describe("a session that already has a sandbox", () => {
  it("resumes it rather than making another", async () => {
    const manager = new InMemorySandboxManager();
    const created = await manager.create(PROJECT_ID);
    if (!created.ok) throw new Error("could not seed a sandbox");

    const acquired = await acquireSandbox(deps(manager), session(created.value.id));

    expect(acquired).toMatchObject({ ok: true, value: { id: created.value.id, created: false } });
  });

  it("pushes the sandbox's deadline out, because a turn means somebody is still here", async () => {
    // Every provider kills a sandbox on a timer that starts when it was created, not when it was
    // last used, so a long conversation would lose its workspace mid-sentence.
    const manager = new InMemorySandboxManager();
    const created = await manager.create(PROJECT_ID);
    if (!created.ok) throw new Error("could not seed a sandbox");
    const { sandbox, extended } = withExtendRecorder(manager);

    await acquireSandbox(deps(sandbox), session(created.value.id));

    expect(extended).toEqual([{ id: created.value.id, ms: TTL_MS }]);
  });
});

describe("a sandbox that is recorded but gone", () => {
  it("fails the turn when there is nothing to restore from", async () => {
    // A fresh sandbox would be an empty template, and the user would be told their turn succeeded
    // while looking at a project with their work missing.
    const manager = new InMemorySandboxManager();

    const acquired = await acquireSandbox(deps(manager), session("sbx_gone"));

    expect(acquired.ok).toBe(false);
  });

  it("restores into a new one, and says so first", async () => {
    // The warning leads the notices because it changes what everything after it means: the
    // project is back, but anything since the last snapshot is not.
    const manager = new InMemorySandboxManager();

    const acquired = await acquireSandbox(deps(manager, { restore: true }), session("sbx_gone"));

    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    expect(acquired.value.created).toBe(true);
    expect(acquired.value.notices[0]).toMatchObject({
      level: "warning",
      text: LOST_SANDBOX_WARNING,
    });
  });
});

describe("a session with no sandbox at all", () => {
  it("creates one and writes it down against the session", async () => {
    // Written down here rather than by the caller: a sandbox nobody recorded is one the next turn
    // cannot find and the reaper cannot sweep.
    const manager = new InMemorySandboxManager();
    const options = deps(manager);

    const acquired = await acquireSandbox(options, session(null));

    expect(acquired).toMatchObject({ ok: true, value: { created: true } });
    if (!acquired.ok) return;
    const stored = await options.sessions.get(SESSION_ID);
    expect(stored?.sandboxId).toBe(acquired.value.id);
  });

  it("reports a creation failure rather than pretending", async () => {
    const manager = new InMemorySandboxManager();
    const failing = wrap(manager, {
      create: async () => ({
        ok: false as const,
        error: { code: "unavailable" as const, message: "no capacity" },
      }),
    });

    const acquired = await acquireSandbox(deps(failing), session(null));

    expect(acquired).toMatchObject({ ok: false, error: { message: "no capacity" } });
  });

  it("has nothing to warn about when the project is new", async () => {
    const manager = new InMemorySandboxManager();

    const acquired = await acquireSandbox(deps(manager, { restore: true }), session(null));

    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    expect(acquired.value.notices).toEqual([]);
  });
});

/**
 * The ceiling that bounds the bill is spent *here*, not at the HTTP route — a request may sit
 * waiting for a minute, and capacity claimed at admission would either expire before it was used
 * or be held for work that never started. What the route still does is refuse the obvious case
 * cheaply; what happens here is what is actually true.
 *
 * How many may run at once is `PostgresSandboxCapacity`'s and is tested against a real Postgres.
 * What these say is the ordering, which is the part a caller can get wrong: reserved before
 * created, released the moment creation fails, and activated only once the sandbox is written
 * down against the session.
 */
describe("the capacity a new sandbox costs", () => {
  it("is reserved before the sandbox is created", async () => {
    const manager = new InMemorySandboxManager();
    const capacity = new InMemorySandboxCapacity();
    const heldWhenCreating: number[] = [];
    const sandbox = wrap(manager, {
      create: async (projectId: string) => {
        heldWhenCreating.push(capacity.held().length);
        return await manager.create(projectId);
      },
    });

    await acquireSandbox({ ...deps(sandbox), capacity }, session(null));

    // A creation that started before its capacity was committed is exactly the overshoot the
    // reservation exists to stop.
    expect(heldWhenCreating).toEqual([1]);
  });

  it("is activated against the sandbox once there is one", async () => {
    const manager = new InMemorySandboxManager();
    const capacity = new InMemorySandboxCapacity();

    const acquired = await acquireSandbox({ ...deps(manager), capacity }, session(null));

    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    expect(capacity.held()).toMatchObject([
      { state: "active", sandboxId: acquired.value.id, projectId: PROJECT_ID, userId: USER_ID },
    ]);
  });

  it("is given back immediately when the creation fails", async () => {
    const manager = new InMemorySandboxManager();
    const capacity = new InMemorySandboxCapacity();
    const failing = wrap(manager, {
      create: async () => ({
        ok: false as const,
        error: { code: "unavailable" as const, message: "no capacity" },
      }),
    });

    const acquired = await acquireSandbox({ ...deps(failing), capacity }, session(null));

    expect(acquired.ok).toBe(false);
    // Not on a timer and not by a sweep: a slot held by a creation that already failed is a
    // sandbox somebody else could have had.
    expect(capacity.held()).toEqual([]);
  });

  it("fails the turn, and creates nothing, when there is none to be had", async () => {
    const manager = new InMemorySandboxManager();
    const capacity = new InMemorySandboxCapacity({ total: 0 });
    let created = 0;
    const sandbox = wrap(manager, {
      create: async (projectId: string) => {
        created += 1;
        return await manager.create(projectId);
      },
    });

    const acquired = await acquireSandbox({ ...deps(sandbox), capacity }, session(null));

    expect(acquired).toMatchObject({ ok: false, error: { code: "unavailable" } });
    expect(created).toBe(0);
  });

  it("carries the refusal's own words, since they say what to do about it", async () => {
    // "Close one of your projects" and "the server is full" are different instructions, and the
    // person reading the failed turn is the only one who can act on either. Compared against what
    // the port actually said rather than against a string typed here, so this pins that the
    // message is carried through and not what the message is.
    const manager = new InMemorySandboxManager();
    const capacity = new InMemorySandboxCapacity({ perUser: 0 });

    const acquired = await acquireSandbox({ ...deps(manager), capacity }, session(null));
    const refusal = await capacity.reserve({ projectId: PROJECT_ID, userId: USER_ID });

    expect(acquired.ok).toBe(false);
    expect(refusal.ok).toBe(false);
    if (acquired.ok || refusal.ok) return;
    expect(acquired.error.message).toBe(refusal.error.message);
  });

  it("costs nothing at all when the session is resuming a sandbox it already has", async () => {
    // Resuming adds nothing to the count, and reserving for it would turn the cap from "sandboxes
    // you may run" into "projects you may talk to".
    const manager = new InMemorySandboxManager();
    const created = await manager.create(PROJECT_ID);
    if (!created.ok) throw new Error("could not seed a sandbox");
    const capacity = new InMemorySandboxCapacity({ total: 0 });

    const acquired = await acquireSandbox(
      { ...deps(manager), capacity },
      session(created.value.id),
    );

    expect(acquired).toMatchObject({ ok: true, value: { created: false } });
  });

  it("reserves for a restore, which makes a sandbox like any other", async () => {
    const manager = new InMemorySandboxManager();
    const capacity = new InMemorySandboxCapacity();

    const acquired = await acquireSandbox(
      { ...deps(manager, { restore: true }), capacity },
      session("sbx_gone"),
    );

    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    expect(capacity.held()).toMatchObject([{ state: "active", sandboxId: acquired.value.id }]);
  });

  it("restores a project whose slot is still held by the sandbox it lost", async () => {
    // The ordinary shape of a provider reclaiming a sandbox behind our back: the row still says
    // this project has one. If that stopped the project reserving, the restore below — the path
    // where a mistake loses somebody's work — could not run until a sweep came past.
    const manager = new InMemorySandboxManager();
    const capacity = new InMemorySandboxCapacity({ total: 1, perUser: 1 });
    const stale = await capacity.reserve({ projectId: PROJECT_ID, userId: USER_ID });
    if (stale.ok) await capacity.activate(stale.value.id, "sbx_gone");

    const acquired = await acquireSandbox(
      { ...deps(manager, { restore: true }), capacity },
      session("sbx_gone"),
    );

    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    expect(acquired.value.notices[0]).toMatchObject({ text: LOST_SANDBOX_WARNING });
    // One slot before and one after: the project reused what it was already holding.
    expect(capacity.held()).toMatchObject([{ state: "active", sandboxId: acquired.value.id }]);
  });

  it("does not fail the turn when the slot cannot be written down", async () => {
    // The sandbox exists and the session is about to be told where it is. Losing the bookkeeping
    // costs a ceiling some accuracy until the row expires; failing here would cost a turn.
    const manager = new InMemorySandboxManager();
    const capacity = new InMemorySandboxCapacity().failAfterReserve(
      new Error("connection terminated"),
    );
    const options = { ...deps(manager), capacity };

    const acquired = await acquireSandbox(options, session(null));

    expect(acquired.ok).toBe(true);
    if (!acquired.ok) return;
    const stored = await options.sessions.get(SESSION_ID);
    expect(stored?.sandboxId).toBe(acquired.value.id);
  });
});
