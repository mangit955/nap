import { InMemorySnapshotStore } from "@nap/db/testing/in-memory-snapshot-store";
import { TEMPLATE_WORKDIR } from "@nap/sandbox/template";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import type { SandboxManager } from "@nap/shared/ports/sandbox-manager";
import type { SnapshotStore } from "@nap/shared/ports/snapshot-store";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { beforeEach, describe, expect, it } from "vitest";
import { captureSnapshot, snapshotKey, tearDownProject } from "./teardown.ts";

const PROJECT = "3e0fbc41-6f5d-4a8e-ab9c-4d5e6f708192";
const SHA = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f80912";

/** A bundle, as base64 — what `git bundle create … && base64` prints. */
const BUNDLE_B64 = Buffer.from("PACK-bundle-bytes").toString("base64");

let sandbox: InMemorySandboxManager;
let objects: InMemoryObjectStore;
let snapshots: InMemorySnapshotStore;
let sandboxId: string;

/** Every command teardown runs, answered the way a real project would answer it. */
function scriptGit(manager: InMemorySandboxManager): InMemorySandboxManager {
  return manager
    .script(/git rev-parse HEAD/, { exitCode: 0, stdout: `${SHA}\n` })
    .script(/git bundle create/, { exitCode: 0, stdout: BUNDLE_B64 });
}

beforeEach(async () => {
  sandbox = scriptGit(new InMemorySandboxManager());
  objects = new InMemoryObjectStore();
  snapshots = new InMemorySnapshotStore();

  const created = await sandbox.create(PROJECT);
  if (!created.ok) throw new Error("could not create a sandbox");
  sandboxId = created.value.id;
  await sandbox.writeFile(sandboxId, `${TEMPLATE_WORKDIR}/src/App.tsx`, "export default null;");
});

/** Every method, bound to the instance, so a spread cannot lose the private state behind it. */
function boundSandbox(manager: SandboxManager): SandboxManager {
  return {
    create: (projectId) => manager.create(projectId),
    resume: (id) => manager.resume(id),
    destroy: (id) => manager.destroy(id),
    extendTimeout: (id, ms) => manager.extendTimeout(id, ms),
    writeFile: (id, path, contents) => manager.writeFile(id, path, contents),
    readFile: (id, path) => manager.readFile(id, path),
    listFiles: (id, path) => manager.listFiles(id, path),
    exec: (id, command, onOutput) => manager.exec(id, command, onOutput),
    getPreviewUrl: (id, port) => manager.getPreviewUrl(id, port),
    waitForPreview: (id, port, opts) => manager.waitForPreview(id, port, opts),
  };
}

function tearDown() {
  return tearDownProject({ sandbox, objects, snapshots, projectId: PROJECT, sandboxId });
}

describe("a successful teardown", () => {
  it("bundles, uploads, writes one row, then destroys the sandbox", async () => {
    // The order is the whole task. Anything that destroys first turns a transient upload
    // failure into a project nobody can open again.
    const result = await tearDown();

    expect(result.ok).toBe(true);
    expect(objects.keys()).toHaveLength(1);
    expect(snapshots.all()).toHaveLength(1);
    await expect(sandbox.resume(sandboxId)).resolves.toMatchObject({
      ok: false,
      error: { code: "destroyed" },
    });
  });

  it("uploads exactly once", async () => {
    await tearDown();

    expect(objects.puts).toBe(1);
  });

  it("stores the bundle's bytes under the key it recorded", async () => {
    await tearDown();

    const [row] = snapshots.all();
    const stored = await objects.get(row?.key ?? "");

    expect(stored.ok && Buffer.from(stored.value).toString()).toBe("PACK-bundle-bytes");
  });

  it("records the commit the bundle actually captured", async () => {
    // Not a timestamp or a guess: restoring is only meaningful if the row says which commit
    // the bytes hold.
    await tearDown();

    expect(snapshots.all()[0]).toMatchObject({ projectId: PROJECT, gitSha: SHA });
  });

  it("reports the key and sha to its caller", async () => {
    const result = await tearDown();

    expect(result).toMatchObject({ ok: true, value: { gitSha: SHA } });
  });
});

describe("the data-loss guard", () => {
  it("does not destroy the sandbox when the upload fails", async () => {
    // The only copy of the user's work is in that sandbox. Destroying it after a failed
    // upload deletes the project, quietly, and the next open finds an empty template.
    objects.failWith({ code: "unavailable", message: "R2 is down" });

    const result = await tearDown();

    expect(result).toMatchObject({ ok: false, error: { reason: "upload_failed" } });
    await expect(sandbox.resume(sandboxId)).resolves.toMatchObject({ ok: true });
  });

  it("writes no row when the upload fails", async () => {
    // A row pointing at an object that was never written is worse than no row: the next open
    // would try to restore from it and find nothing.
    objects.failWith({ code: "unavailable", message: "R2 is down" });

    await tearDown();

    expect(snapshots.all()).toEqual([]);
  });

  it("does not destroy the sandbox when the row cannot be written", async () => {
    // The bytes are safely uploaded by this point, but nothing points at them — so the
    // sandbox is still the only findable copy.
    snapshots.failWith(new Error("database is down"));

    const result = await tearDown();

    expect(result).toMatchObject({ ok: false, error: { reason: "record_failed" } });
    await expect(sandbox.resume(sandboxId)).resolves.toMatchObject({ ok: true });
  });

  it("does not destroy the sandbox when the bundle cannot be made", async () => {
    const broken = new InMemorySandboxManager({ defaultExec: () => ({ exitCode: 128 }) });
    const created = await broken.create(PROJECT);
    if (!created.ok) throw new Error("could not create a sandbox");

    const result = await tearDownProject({
      sandbox: broken,
      objects,
      snapshots,
      projectId: PROJECT,
      sandboxId: created.value.id,
    });

    expect(result).toMatchObject({ ok: false, error: { reason: "bundle_failed" } });
    await expect(broken.resume(created.value.id)).resolves.toMatchObject({ ok: true });
    expect(objects.puts).toBe(0);
  });

  it("keeps the uploaded object when the row fails, rather than deleting it", async () => {
    // Tempting to clean up, and wrong: the bytes are the user's project. An operator can
    // find an orphaned object; nobody can find a deleted one.
    snapshots.failWith(new Error("database is down"));

    await tearDown();

    expect(objects.keys()).toHaveLength(1);
  });
});

describe("when the sandbox will not go away", () => {
  it("still reports success, because the project is already safe", async () => {
    // The snapshot is written and the row is recorded; a sandbox that refuses to die is a
    // billing problem for whatever runs next, not a failed teardown. `destroyed: false` is
    // how the caller finds out, which is the only reason that field exists.
    // Delegation rather than a Proxy or Object.create: the fake keeps its state in `#private`
    // fields, and those throw through either because the receiver is no longer the instance.
    const undestroyable: SandboxManager = {
      ...boundSandbox(sandbox),
      destroy: async () => ({ ok: false, error: { code: "unavailable", message: "busy" } }),
    };

    const result = await tearDownProject({
      sandbox: undestroyable,
      objects,
      snapshots,
      projectId: PROJECT,
      sandboxId,
    });

    expect(result).toMatchObject({ ok: true, value: { destroyed: false } });
    expect(snapshots.all()).toHaveLength(1);
  });
});

describe("snapshotKey", () => {
  it("puts every project's snapshots under its own prefix", () => {
    expect(snapshotKey(PROJECT, SHA, 1)).toMatch(new RegExp(`^projects/${PROJECT}/`));
  });

  it("names the commit it holds", () => {
    expect(snapshotKey(PROJECT, SHA, 1)).toContain(SHA);
  });

  it("is unique per teardown, even at the same commit", () => {
    // Tearing down twice with no changes in between produces the same sha. Reusing the key
    // would overwrite the older snapshot, which is fine — but the rows would then both point
    // at one object, and deleting either would break the other.
    expect(snapshotKey(PROJECT, SHA, 1)).not.toBe(snapshotKey(PROJECT, SHA, 2));
  });

  it("contains nothing that needs escaping in a URL", () => {
    expect(snapshotKey(PROJECT, SHA, 1)).toMatch(/^[a-zA-Z0-9/._-]+$/);
  });
});

describe("a sandbox that is already gone", () => {
  it("is reported as such rather than as a failed bundle", async () => {
    // E2B kills sandboxes on its own timer, so a row can outlive the thing it names. The
    // caller has to be able to tell "I could not snapshot this" from "there is nothing left
    // to snapshot" — one is worth retrying every minute and the other never is.
    await sandbox.destroy(sandboxId);

    const result = await tearDown();

    expect(result).toMatchObject({ ok: false, error: { reason: "sandbox_gone" } });
  });

  it("still reports a genuine git failure as a failed bundle", async () => {
    // The distinction is the sandbox being unreachable, not any failure while reading it.
    sandbox.script(/git rev-parse HEAD/, { exitCode: 128, stderr: "fatal: not a git repository" });

    const result = await tearDown();

    expect(result).toMatchObject({ ok: false, error: { reason: "bundle_failed" } });
  });
});

describe("captureSnapshot", () => {
  function capture() {
    return captureSnapshot({ sandbox, objects, snapshots, projectId: PROJECT, sandboxId });
  }

  it("uploads the bundle and records the row", async () => {
    const result = await capture();

    expect(result).toMatchObject({ ok: true, value: { gitSha: SHA } });
    expect(objects.keys()).toHaveLength(1);
    expect(snapshots.all()).toHaveLength(1);
  });

  it("leaves the sandbox running, which is the whole difference from a teardown", async () => {
    // This is what makes it usable at the end of a turn: the work is safe in R2 *and* the
    // user's project is still there to carry on editing.
    await capture();

    await expect(sandbox.resume(sandboxId)).resolves.toMatchObject({ ok: true });
  });

  it("reports an upload failure without writing a row", async () => {
    objects.failWith({ code: "unavailable", message: "R2 is down" });

    const result = await capture();

    expect(result).toMatchObject({ ok: false, error: { reason: "upload_failed" } });
    expect(snapshots.all()).toEqual([]);
  });

  it("reports a sandbox that has gone as such, not as a broken bundle", async () => {
    await sandbox.destroy(sandboxId);

    await expect(capture()).resolves.toMatchObject({
      ok: false,
      error: { reason: "sandbox_gone" },
    });
  });
});

describe("tearing down a project that has not changed since its last snapshot", () => {
  /** A snapshot already recorded at the commit the sandbox is currently sitting on. */
  async function alreadySnapshotted(gitSha = SHA) {
    // Only the row, deliberately — recording a snapshot touches no object store, so `puts`
    // stays at zero and any upload the teardown makes is unambiguously its own.
    await snapshots.record({ projectId: PROJECT, key: "projects/p/existing.bundle", gitSha });
  }

  it("does not bundle or upload again", async () => {
    // Once a turn snapshots its own work, the reaper arrives minutes later at the same commit.
    // Re-bundling it would write a second object holding byte-identical content.
    await alreadySnapshotted();

    const result = await tearDown();

    expect(result).toMatchObject({ ok: true, value: { captured: false } });
    expect(objects.puts).toBe(0);
    expect(snapshots.all()).toHaveLength(1);
  });

  it("still destroys the sandbox, because that is what a teardown is for", async () => {
    await alreadySnapshotted();

    await tearDown();

    await expect(sandbox.resume(sandboxId)).resolves.toMatchObject({
      ok: false,
      error: { code: "destroyed" },
    });
  });

  it("hands back the existing key, so the project still points at its snapshot", async () => {
    // The caller writes this onto the project row. A null or a fresh key here would strand the
    // real snapshot and leave the project pointing at nothing.
    await alreadySnapshotted();

    const result = await tearDown();

    expect(result).toMatchObject({
      ok: true,
      value: { key: "projects/p/existing.bundle", gitSha: SHA },
    });
  });

  it("does capture when the commit has moved on", async () => {
    await alreadySnapshotted("0000000000000000000000000000000000000000");

    const result = await tearDown();

    expect(result).toMatchObject({ ok: true, value: { captured: true } });
    expect(objects.puts).toBe(1);
    expect(snapshots.all()).toHaveLength(2);
  });

  it("captures when the project has never been snapshotted", async () => {
    const result = await tearDown();

    expect(result).toMatchObject({ ok: true, value: { captured: true } });
    expect(objects.puts).toBe(1);
  });

  it("captures rather than failing when the lookup itself is unavailable", async () => {
    // "Has it changed?" is an optimisation. A database that cannot answer it must cost a
    // redundant upload, never the snapshot — this runs on the path that saves the work.
    const unreadable: SnapshotStore = {
      record: (snapshot) => snapshots.record(snapshot),
      latestFor: async () => {
        throw new Error("database is down");
      },
      listFor: (projectId) => snapshots.listFor(projectId),
    };

    const result = await tearDownProject({
      sandbox,
      objects,
      snapshots: unreadable,
      projectId: PROJECT,
      sandboxId,
    });

    expect(result).toMatchObject({ ok: true, value: { captured: true } });
    expect(objects.puts).toBe(1);
  });
});
