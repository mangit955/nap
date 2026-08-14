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
 * Spread rather than `Object.create`: the fake keeps its state in private fields, and a delegate
 * whose prototype is the instance fails on the first access with "Receiver must be an instance of".
 * Every method is bound to the original, so the copy shares its sandboxes.
 */
function wrap(manager: InMemorySandboxManager, over: Partial<SandboxManager>): SandboxManager {
  const bound = {
    create: manager.create.bind(manager),
    resume: manager.resume.bind(manager),
    destroy: manager.destroy.bind(manager),
    extendTimeout: manager.extendTimeout.bind(manager),
    writeFile: manager.writeFile.bind(manager),
    readFile: manager.readFile.bind(manager),
    listFiles: manager.listFiles.bind(manager),
    exec: manager.exec.bind(manager),
    getPreviewUrl: manager.getPreviewUrl.bind(manager),
    waitForPreview: manager.waitForPreview.bind(manager),
  } as unknown as SandboxManager;

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
