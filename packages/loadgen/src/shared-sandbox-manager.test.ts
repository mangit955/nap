/**
 * The fake sandbox, shared between processes.
 *
 * Everything here is two managers over one store, because that is the situation the wrapper
 * exists for and the one a single-process run can never reach: a project whose sandbox was
 * created by one worker pod and whose next turn is claimed by another. Without a shared store
 * the second pod's `resume` misses, the runtime opens a new sandbox, and the run measures the
 * fake's declared cold start rather than the deployment — see `docs/scaling-cluster.md`.
 */

import { describeSandboxManagerConformance } from "@nap/sandbox/testing/conformance";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import type { SandboxManager } from "@nap/shared/ports/sandbox-manager";
import { describe, expect, it } from "vitest";
import {
  type SharedSandboxRecord,
  type SharedSandboxStore,
  sharedSandboxManager,
} from "./shared-sandbox-manager.ts";
import { slowSandboxManager } from "./slow-ports.ts";

/** Stands in for the Postgres one; the point of the port is that this is all it has to do. */
class InMemorySharedSandboxStore implements SharedSandboxStore {
  readonly #records = new Map<string, SharedSandboxRecord>();

  async record(record: SharedSandboxRecord): Promise<void> {
    this.#records.set(record.sandboxId, { ...record, files: { ...record.files } });
  }

  async find(sandboxId: string): Promise<SharedSandboxRecord | null> {
    const found = this.#records.get(sandboxId);
    return found === undefined ? null : { ...found, files: { ...found.files } };
  }

  async saveFiles(sandboxId: string, files: Record<string, string>): Promise<void> {
    const found = this.#records.get(sandboxId);
    if (found !== undefined) found.files = { ...files };
  }

  async forget(sandboxId: string): Promise<void> {
    this.#records.delete(sandboxId);
  }
}

/** The two commands the conformance suite needs, in the only dialect the fake speaks. */
const STREAMS_OUTPUT = "printf 'one\\n'; printf 'two\\n' >&2";
const FAILS_WITH_CODE_3 = "exit 3";

/** The wrapped manager, as every test here builds it. */
function scriptedManager(): InMemorySandboxManager {
  return new InMemorySandboxManager({
    defaultExec: () => ({ exitCode: 0, stdout: "" }),
    serves: [5173],
    seed: { "/home/user/app/package.json": "{}" },
  })
    .script(STREAMS_OUTPUT, { stdout: "one\n", stderr: "two\n" })
    .script(FAILS_WITH_CODE_3, { exitCode: 3 });
}

/** One worker pod: its own in-memory sandboxes, the shared store underneath. */
function pod(store: SharedSandboxStore): SandboxManager {
  return sharedSandboxManager(scriptedManager(), store);
}

async function created(manager: SandboxManager, projectId = "project-1"): Promise<string> {
  const sandbox = await manager.create(projectId);
  if (!sandbox.ok) throw new Error(`create failed: ${sandbox.error.message}`);
  return sandbox.value.id;
}

/**
 * The wrapper's whole defence is that it delegates, so the contract the thing it wraps is held
 * to is the contract it has to keep. Run over one process's manager, because that is what the
 * suite can express; everything cross-process is below.
 */
describeSandboxManagerConformance({
  name: "sharedSandboxManager",
  root: "/home/user",
  commands: { streamsOutput: STREAMS_OUTPUT, failsWithCode3: FAILS_WITH_CODE_3 },
  // Any string is well-formed here: neither the fake nor the store validates an id's shape.
  unknownSandboxId: () => `unknown-${crypto.randomUUID()}`,
  createManager: async () => ({
    manager: sharedSandboxManager(scriptedManager(), new InMemorySharedSandboxStore()),
    cleanup: async () => {
      // Nothing to release: the sandboxes and the store both go with the instance.
    },
  }),
});

describe("sharedSandboxManager", () => {
  it("reattaches to a sandbox another process created, under the same id", async () => {
    const store = new InMemorySharedSandboxStore();
    const first = pod(store);
    const second = pod(store);

    const sandboxId = await created(first);

    await expect(second.resume(sandboxId)).resolves.toEqual({
      ok: true,
      value: { id: sandboxId, projectId: "project-1" },
    });
  });

  it("carries the files across, so a project's work is not lost with its pod", async () => {
    const store = new InMemorySharedSandboxStore();
    const first = pod(store);
    const second = pod(store);

    const sandboxId = await created(first);
    await first.writeFile(sandboxId, "/home/user/app/src/App.tsx", "export const App = 1;\n");

    await second.resume(sandboxId);

    await expect(second.readFile(sandboxId, "/home/user/app/src/App.tsx")).resolves.toEqual({
      ok: true,
      value: "export const App = 1;\n",
    });
  });

  it("brings the template's own files with it, from the seed rather than the store", async () => {
    const store = new InMemorySharedSandboxStore();
    const sandboxId = await created(pod(store));
    const second = pod(store);

    await second.resume(sandboxId);

    await expect(second.readFile(sandboxId, "/home/user/app/package.json")).resolves.toMatchObject({
      ok: true,
    });
  });

  it("serves a preview from the reattached sandbox, at the shared id", async () => {
    const store = new InMemorySharedSandboxStore();
    const sandboxId = await created(pod(store));
    const second = pod(store);

    await second.resume(sandboxId);

    const preview = await second.waitForPreview(sandboxId, 5173);
    expect(preview.ok).toBe(true);
    // The address a real provider composes is stable across reattaches because it is derived
    // from the sandbox's id; one that changed per pod would be a fake nobody could follow.
    if (preview.ok) expect(preview.value).toContain(sandboxId);
  });

  it("runs commands against the reattached sandbox rather than a stranger's", async () => {
    const store = new InMemorySharedSandboxStore();
    const sandboxId = await created(pod(store));
    const second = pod(store);

    await second.resume(sandboxId);

    await expect(second.exec(sandboxId, "npm run build")).resolves.toMatchObject({ ok: true });
  });

  it("does not find a sandbox nobody created", async () => {
    const store = new InMemorySharedSandboxStore();

    await expect(pod(store).resume("never-existed")).resolves.toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });

  it("does not resurrect a destroyed sandbox anywhere", async () => {
    const store = new InMemorySharedSandboxStore();
    const first = pod(store);
    const sandboxId = await created(first);

    await first.destroy(sandboxId);

    await expect(pod(store).resume(sandboxId)).resolves.toMatchObject({ ok: false });
    await expect(first.resume(sandboxId)).resolves.toMatchObject({ ok: false });
  });

  it("keeps writing through after a reattach, for the pod that claims the turn after that", async () => {
    const store = new InMemorySharedSandboxStore();
    const sandboxId = await created(pod(store));

    const second = pod(store);
    await second.resume(sandboxId);
    await second.writeFile(sandboxId, "/home/user/app/src/Two.tsx", "two\n");

    const third = pod(store);
    await third.resume(sandboxId);

    await expect(third.readFile(sandboxId, "/home/user/app/src/Two.tsx")).resolves.toEqual({
      ok: true,
      value: "two\n",
    });
  });

  it("destroys the record from a process that never held the sandbox", async () => {
    const store = new InMemorySharedSandboxStore();
    const sandboxId = await created(pod(store));

    // The reaper is exactly this process: it sweeps idle projects and has attached nothing.
    await expect(pod(store).destroy(sandboxId)).resolves.toMatchObject({ ok: true });

    await expect(pod(store).resume(sandboxId)).resolves.toMatchObject({ ok: false });
  });

  it("does not hand back a sandbox another process destroyed, even to the one that made it", async () => {
    const store = new InMemorySharedSandboxStore();
    const first = pod(store);
    const sandboxId = await created(first);

    await pod(store).destroy(sandboxId);

    // The whole reason the runtime restores from a snapshot: a sandbox that is gone has to
    // read as gone everywhere, or the turn runs in one nobody else can see.
    await expect(first.resume(sandboxId)).resolves.toMatchObject({ ok: false });
  });

  it("costs a reattach rather than a cold start, which is the whole point", async () => {
    const store = new InMemorySharedSandboxStore();
    const slept: number[] = [];
    const sleep = async (ms: number) => {
      slept.push(ms);
    };

    // The order the compositions use: the calibrated wait wraps the shared store, so a
    // reattach never reaches the `create` the cold start is attached to.
    const first = slowSandboxManager(pod(store), { sleep });
    const sandboxId = await created(first);
    slept.length = 0;

    const second = slowSandboxManager(pod(store), { sleep });
    await expect(second.resume(sandboxId)).resolves.toMatchObject({ ok: true });

    expect(slept).toEqual([]);
  });
});
