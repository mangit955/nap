import { FAKE_OWNER, InMemoryProjectStore } from "@nap/db/testing/in-memory-project-store";
import { InMemorySnapshotStore } from "@nap/db/testing/in-memory-snapshot-store";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { beforeEach, describe, expect, it } from "vitest";
import { deleteProject } from "./delete-project.ts";

const PROJECT = "3e0fbc41-6f5d-4a8e-ab9c-4d5e6f708192";

let projects: InMemoryProjectStore;
let snapshots: InMemorySnapshotStore;
let objects: InMemoryObjectStore;
let sandbox: InMemorySandboxManager;
let sandboxId: string;

/** A project with two snapshots behind it and a sandbox still running. */
beforeEach(async () => {
  sandbox = new InMemorySandboxManager();
  const created = await sandbox.create(PROJECT);
  if (!created.ok) throw new Error("could not create a sandbox");
  sandboxId = created.value.id;

  objects = new InMemoryObjectStore();
  snapshots = new InMemorySnapshotStore();

  for (const key of [`projects/${PROJECT}/1-aaa.bundle`, `projects/${PROJECT}/2-bbb.bundle`]) {
    await objects.put(key, new TextEncoder().encode("PACK"));
    await snapshots.record({ projectId: PROJECT, key, gitSha: key.slice(-11, -7) });
  }

  projects = new InMemoryProjectStore([
    {
      projectId: PROJECT,
      name: "Todo app",
      status: "ready",
      sandboxId,
      updatedAt: "2026-08-09T11:00:00.000Z",
      sessionIds: ["2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77"],
    },
  ]);
});

function remove() {
  return deleteProject({
    projects,
    snapshots,
    objects,
    sandbox,
    projectId: PROJECT,
    userId: FAKE_OWNER,
  });
}

describe("deleting a project", () => {
  it("leaves no objects behind", async () => {
    // The assertion this task exists for. An object nobody references is unfindable — keys are
    // per project and the rows that hold them are about to be deleted — and paid for forever.
    const result = await remove();

    expect(result).toMatchObject({ ok: true, value: { deleted: true, objectsDeleted: 2 } });
    expect(objects.keys()).toEqual([]);
  });

  it("removes the row, and with it everything the database hangs off it", async () => {
    await remove();

    await expect(projects.get(PROJECT, FAKE_OWNER)).resolves.toBeNull();
  });

  it("destroys the sandbox rather than leaving it running", async () => {
    const result = await remove();

    expect(result).toMatchObject({ ok: true, value: { sandboxDestroyed: true } });
    await expect(sandbox.resume(sandboxId)).resolves.toMatchObject({
      ok: false,
      error: { code: "destroyed" },
    });
  });

  it("deletes a project that has never been snapshotted", async () => {
    const empty = new InMemorySnapshotStore();

    const result = await deleteProject({
      projects,
      snapshots: empty,
      objects,
      sandbox,
      projectId: PROJECT,
      userId: FAKE_OWNER,
    });

    expect(result).toMatchObject({ ok: true, value: { deleted: true, objectsDeleted: 0 } });
  });
});

describe("a project that is not there", () => {
  it("succeeds, saying it deleted nothing", async () => {
    // Two clicks on the same button, or two tabs. The second is finding out the row is already
    // gone, which is what it wanted — not an error to show somebody.
    const result = await deleteProject({
      projects,
      snapshots,
      objects,
      sandbox,
      projectId: "6b7c8d9e-0f1a-4b2c-8d3e-4f5a6b7c8d9e",
      userId: FAKE_OWNER,
    });

    expect(result).toMatchObject({ ok: true, value: { deleted: false } });
  });

  it("touches nothing", async () => {
    await deleteProject({
      projects,
      snapshots,
      objects,
      sandbox,
      projectId: "6b7c8d9e-0f1a-4b2c-8d3e-4f5a6b7c8d9e",
      userId: FAKE_OWNER,
    });

    expect(objects.keys()).toHaveLength(2);
    await expect(projects.get(PROJECT, FAKE_OWNER)).resolves.not.toBeNull();
  });
});

describe("when object storage fails", () => {
  it("stops before deleting the rows that name the objects", async () => {
    // Delete the rows now and every object this loop had not reached is stranded: unreferenced,
    // unfindable, and billed. The rows are what makes a retry possible.
    objects.failWith({ code: "unavailable", message: "R2 is not answering" });

    const result = await remove();

    expect(result).toMatchObject({ ok: false, error: { reason: "objects_failed" } });
    await expect(projects.get(PROJECT, FAKE_OWNER)).resolves.not.toBeNull();
    expect(snapshots.all()).toHaveLength(2);
  });

  it("can be retried once storage comes back", async () => {
    objects.failWith({ code: "unavailable", message: "R2 is not answering" });
    await remove();

    objects.failWith(undefined);
    const retried = await remove();

    expect(retried).toMatchObject({ ok: true, value: { deleted: true } });
    expect(objects.keys()).toEqual([]);
  });
});

describe("when the rows cannot be deleted", () => {
  it("reports it, and the objects are already gone so a retry finishes the job", async () => {
    // `delete` of a missing key succeeds, which is what makes the second attempt harmless.
    projects.failDeleteWith(new Error("connection terminated"));

    const result = await remove();

    expect(result).toMatchObject({ ok: false, error: { reason: "rows_failed" } });
    expect(objects.keys()).toEqual([]);
  });
});
