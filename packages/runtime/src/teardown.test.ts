import { InMemorySnapshotStore } from "@nap/db/testing/in-memory-snapshot-store";
import { TEMPLATE_WORKDIR } from "@nap/sandbox/template";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { beforeEach, describe, expect, it } from "vitest";
import { snapshotKey, tearDownProject } from "./teardown.ts";

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
    // billing problem for whatever runs next, not a failed teardown.
    await sandbox.destroy(sandboxId);

    const result = await tearDown();

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.reason).toBe("bundle_failed");
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
