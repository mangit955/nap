import { InMemoryProjectSandboxStore } from "@nap/db/testing/in-memory-project-sandbox-store";
import { InMemorySnapshotStore } from "@nap/db/testing/in-memory-snapshot-store";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { beforeEach, describe, expect, it } from "vitest";
import { putProjectAway } from "./close-project.ts";

const PROJECT = "3e0fbc41-6f5d-4a8e-ab9c-4d5e6f708192";
const SHA = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f80912";
const ACTIVE = "2026-08-09T11:00:00.000Z";

let sandbox: InMemorySandboxManager;
let objects: InMemoryObjectStore;
let snapshots: InMemorySnapshotStore;
let projects: InMemoryProjectSandboxStore;
let sandboxId: string;

beforeEach(async () => {
  sandbox = new InMemorySandboxManager()
    .script(/git rev-parse HEAD/, { exitCode: 0, stdout: `${SHA}\n` })
    .script(/git bundle create/, {
      exitCode: 0,
      stdout: Buffer.from("PACK-bundle-bytes").toString("base64"),
    });
  objects = new InMemoryObjectStore();
  snapshots = new InMemorySnapshotStore();

  const created = await sandbox.create(PROJECT);
  if (!created.ok) throw new Error("could not create a sandbox");
  sandboxId = created.value.id;

  projects = new InMemoryProjectSandboxStore([
    { projectId: PROJECT, sandboxId, lastActiveAt: ACTIVE },
  ]);
});

function close(id = sandboxId) {
  return putProjectAway({
    projects,
    sandbox,
    objects,
    snapshots,
    projectId: PROJECT,
    sandboxId: id,
  });
}

describe("closing a project", () => {
  it("snapshots it, destroys the sandbox and records where the bytes went", async () => {
    const result = await close();

    expect(result).toMatchObject({ outcome: "put_away" });
    expect(objects.keys()).toHaveLength(1);
    expect(projects.get(PROJECT)).toMatchObject({
      sandboxId: null,
      snapshotKey: snapshots.all()[0]?.key,
    });
    await expect(sandbox.resume(sandboxId)).resolves.toMatchObject({
      ok: false,
      error: { code: "destroyed" },
    });
  });
});

describe("when the snapshot cannot be taken", () => {
  it("leaves the sandbox alive and the project still pointing at it", async () => {
    // The sandbox holds the only current copy of the work until the upload lands.
    objects.failWith({ code: "unavailable", message: "R2 is not answering" });

    const result = await close();

    expect(result).toMatchObject({ outcome: "failed", reason: "upload_failed" });
    expect(projects.get(PROJECT)?.sandboxId).toBe(sandboxId);
    await expect(sandbox.resume(sandboxId)).resolves.toMatchObject({ ok: true });
  });
});

describe("when the sandbox has already gone", () => {
  it("drops the reference instead of failing forever", async () => {
    await sandbox.destroy(sandboxId);

    const result = await close();

    expect(result).toEqual({ outcome: "abandoned" });
    expect(projects.get(PROJECT)?.sandboxId).toBeNull();
  });

  it("keeps whatever snapshot the project already had", async () => {
    // Nothing new was captured, and the key already recorded may be the last copy there is.
    projects = new InMemoryProjectSandboxStore([
      {
        projectId: PROJECT,
        sandboxId: "gone",
        snapshotKey: "projects/p/earlier.bundle",
        lastActiveAt: ACTIVE,
      },
    ]);

    await close("gone");

    expect(projects.get(PROJECT)?.snapshotKey).toBe("projects/p/earlier.bundle");
  });
});

describe("when the bookkeeping fails", () => {
  it("reports it, even though the snapshot is safe", async () => {
    projects.failWith(new Error("connection terminated"));

    const result = await close();

    expect(result).toMatchObject({ outcome: "failed", reason: "release_failed" });
    // The bytes did land — the next turn restores from them once the row catches up.
    expect(objects.keys()).toHaveLength(1);
  });
});
