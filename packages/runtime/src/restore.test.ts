import { InMemorySnapshotStore } from "@nap/db/testing/in-memory-snapshot-store";
import { TEMPLATE_WORKDIR } from "@nap/sandbox/template";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import type { Sandbox, SandboxError } from "@nap/shared/ports/sandbox-manager";
import type { Result } from "@nap/shared/result";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { beforeEach, describe, expect, it } from "vitest";
import { openProject } from "./restore.ts";

const PROJECT = "3e0fbc41-6f5d-4a8e-ab9c-4d5e6f708192";
const SHA = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f80912";
const KEY = `projects/${PROJECT}/1735689600000-${SHA}.bundle`;
const LOCKFILE = `${TEMPLATE_WORKDIR}/bun.lock`;

/** A bundle, as the bytes an object store hands back. */
const BUNDLE = new TextEncoder().encode("PACK-bundle-bytes");

/**
 * The fake cannot fail a `create`, and the guard that matters most here is about what happens
 * *before* one: a sandbox created and then abandoned is billed for nothing.
 */
class CountingSandboxManager extends InMemorySandboxManager {
  creates = 0;
  /** The most recent sandbox, so a scripted command can act on a sandbox it did not make. */
  lastCreatedId: string | null = null;
  #createFailure: SandboxError | undefined;

  failCreateWith(error: SandboxError): this {
    this.#createFailure = error;
    return this;
  }

  override async create(projectId: string): Promise<Result<Sandbox, SandboxError>> {
    this.creates += 1;
    if (this.#createFailure !== undefined) return { ok: false, error: this.#createFailure };

    const created = await super.create(projectId);
    if (created.ok) this.lastCreatedId = created.value.id;
    return created;
  }
}

let sandbox: CountingSandboxManager;
let objects: InMemoryObjectStore;
let snapshots: InMemorySnapshotStore;

/** Every command a restore runs, answered the way a real project would answer it. */
function scriptRestore(manager: CountingSandboxManager): CountingSandboxManager {
  return manager
    .script(/base64 -d/, { exitCode: 0 })
    .script(/git fetch/, { exitCode: 0 })
    .script(/git reset --hard/, { exitCode: 0 })
    .script(/git clean/, { exitCode: 0 })
    .script(/bun install/, { exitCode: 0, stdout: "Checked 42 installs" });
}

/** Makes the restore land a lockfile that differs from the template's. */
function restoreChangesTheLockfile(manager: CountingSandboxManager, contents = "changed"): void {
  manager.script(/git reset --hard/, async () => {
    if (manager.lastCreatedId !== null) {
      await manager.writeFile(manager.lastCreatedId, LOCKFILE, contents);
    }
    return { exitCode: 0 };
  });
}

beforeEach(() => {
  sandbox = scriptRestore(new CountingSandboxManager());
  objects = new InMemoryObjectStore();
  snapshots = new InMemorySnapshotStore();
});

function open() {
  return openProject({ sandbox, objects, snapshots, projectId: PROJECT });
}

/** A project that was torn down once: a row pointing at a bundle that is really there. */
async function seedSnapshot(bytes: Uint8Array = BUNDLE): Promise<void> {
  await objects.put(KEY, bytes);
  await snapshots.record({ projectId: PROJECT, key: KEY, gitSha: SHA });
}

describe("a project that has never been torn down", () => {
  it("comes up as a fresh template, with nothing to apologise for", async () => {
    const opened = await open();

    expect(opened).toMatchObject({ ok: true, value: { restored: false, warning: null } });
    // No snapshot is the ordinary state of a brand-new project. Warning about it would
    // teach the user to ignore the one warning that matters.
    expect(sandbox.creates).toBe(1);
  });

  it("runs no git and no install", async () => {
    const opened = await open();
    if (!opened.ok) throw new Error("expected the open to succeed");

    expect(sandbox.commands(opened.value.sandboxId)).toEqual([]);
  });
});

describe("a project with a snapshot", () => {
  it("restores it into a fresh sandbox", async () => {
    await seedSnapshot();

    const opened = await open();

    expect(opened).toMatchObject({ ok: true, value: { restored: true, warning: null } });
  });

  it("fetches and resets from the bundle, then cleans the tree", async () => {
    await seedSnapshot();

    const opened = await open();
    if (!opened.ok) throw new Error("expected the open to succeed");

    // Order, not membership: resetting before the fetch would reset onto the template's own
    // HEAD and report a successful restore of nothing.
    const commands = sandbox.commands(opened.value.sandboxId).join("\n");
    expect(commands).toMatch(/base64 -d[\s\S]*git fetch[\s\S]*git reset --hard[\s\S]*git clean/);
  });
});

describe("dependencies", () => {
  it("installs when the restored lockfile differs from the template's", async () => {
    await seedSnapshot();
    restoreChangesTheLockfile(sandbox);

    const opened = await open();
    if (!opened.ok) throw new Error("expected the open to succeed");

    expect(opened.value.installed).toBe(true);
    expect(sandbox.commands(opened.value.sandboxId).filter((c) => /bun install/.test(c))).toEqual([
      `cd ${TEMPLATE_WORKDIR} && bun install`,
    ]);
  });

  it("skips the install when the lockfile is unchanged", async () => {
    await seedSnapshot();

    const opened = await open();
    if (!opened.ok) throw new Error("expected the open to succeed");

    // The whole point of the baked template is that opening a project does not install.
    expect(opened.value.installed).toBe(false);
    expect(sandbox.commands(opened.value.sandboxId).some((c) => /bun install/.test(c))).toBe(false);
  });

  it("treats a lockfile that only now exists as a change", async () => {
    await seedSnapshot();
    restoreChangesTheLockfile(sandbox, "a lockfile the template did not have");

    const opened = await open();

    expect(opened).toMatchObject({ ok: true, value: { installed: true } });
  });

  it("keeps the restored project when the install fails, and says so", async () => {
    await seedSnapshot();
    restoreChangesTheLockfile(sandbox);
    sandbox.script(/bun install/, { exitCode: 1, stderr: "no such package" });

    const opened = await open();

    // The code is restored and readable; only the dependencies are behind. Failing the open
    // would hide a project the user can still see and edit.
    expect(opened).toMatchObject({ ok: true, value: { restored: true, installed: false } });
    if (!opened.ok) return;
    expect(opened.value.warning).toMatch(/dependenc/i);
  });
});

describe("a snapshot that cannot be applied", () => {
  it("falls back to a fresh template with a warning when the bundle is missing", async () => {
    // The row survives; the object does not. An operator deleting a bucket must not make a
    // project unopenable.
    await snapshots.record({ projectId: PROJECT, key: KEY, gitSha: SHA });

    const opened = await open();

    expect(opened.ok).toBe(true);
    if (!opened.ok) return;
    expect(opened.value.restored).toBe(false);
    expect(opened.value.warning).toMatch(/snapshot/i);
    expect(opened.value.sandboxId).not.toBe("");
  });

  it("falls back to a fresh template when git refuses the bundle", async () => {
    await seedSnapshot(new TextEncoder().encode("not a bundle at all"));
    sandbox.script(/git fetch/, { exitCode: 128, stderr: "fatal: not a valid object name" });

    const opened = await open();

    expect(opened).toMatchObject({ ok: true, value: { restored: false } });
    if (!opened.ok) return;
    expect(opened.value.warning).toMatch(/snapshot/i);
  });

  it("does not install after a failed restore", async () => {
    await seedSnapshot();
    sandbox.script(/git fetch/, { exitCode: 128, stderr: "fatal: not a valid object name" });

    const opened = await open();
    if (!opened.ok) throw new Error("expected the open to succeed");

    // The tree is the template's, so its lockfile is the template's. An install here would
    // spend a minute reaching the state it is already in.
    expect(sandbox.commands(opened.value.sandboxId).some((c) => /bun install/.test(c))).toBe(false);
  });
});

describe("failures that must not become an empty project", () => {
  it("fails the open when object storage cannot be reached", async () => {
    await seedSnapshot();
    objects.failWith({ code: "unavailable", message: "R2 is not answering" });

    const opened = await open();

    // Unreachable is not the same as absent. Handing back a template here would let the
    // next teardown overwrite a good snapshot with an empty one.
    expect(opened).toMatchObject({ ok: false, error: { reason: "snapshot_unavailable" } });
  });

  it("creates no sandbox when it cannot read the bundle", async () => {
    await seedSnapshot();
    objects.failWith({ code: "unavailable", message: "R2 is not answering" });

    await open();

    // Everything that can fail without a sandbox happens before there is one to abandon.
    expect(sandbox.creates).toBe(0);
  });

  it("fails the open when the snapshot row cannot be read", async () => {
    snapshots.failWith(new Error("connection terminated"));
    // `failWith` covers writes; make the read fail the same way a dead database would.
    snapshots.latestFor = () => Promise.reject(new Error("connection terminated"));

    const opened = await open();

    expect(opened).toMatchObject({ ok: false, error: { reason: "snapshot_unavailable" } });
    expect(sandbox.creates).toBe(0);
  });

  it("reports a sandbox that could not be created", async () => {
    await seedSnapshot();
    sandbox.failCreateWith({ code: "unavailable", message: "no capacity in us-east-1" });

    const opened = await open();

    expect(opened).toMatchObject({
      ok: false,
      error: { reason: "sandbox_unavailable", message: expect.stringContaining("no capacity") },
    });
  });
});
