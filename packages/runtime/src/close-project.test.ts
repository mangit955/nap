import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemoryProjectSandboxStore } from "@nap/db/testing/in-memory-project-sandbox-store";
import { InMemorySnapshotStore } from "@nap/db/testing/in-memory-snapshot-store";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { beforeEach, describe, expect, it } from "vitest";
import { putProjectAway } from "./close-project.ts";

const PROJECT = "3e0fbc41-6f5d-4a8e-ab9c-4d5e6f708192";
const SHA = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f80912";
const ACTIVE = "2026-08-09T11:00:00.000Z";
/** Two, because a sandbox belongs to the project every one of its sessions shares. */
const SESSIONS = ["0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f", "1c8f9f2e-4d3b-4e6c-af7a-2b3c4d5e6f70"];

let sandbox: InMemorySandboxManager;
let objects: InMemoryObjectStore;
let snapshots: InMemorySnapshotStore;
let projects: InMemoryProjectSandboxStore;
let events: InMemoryEventStore;
let bus: InMemoryEventBus;
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
  events = new InMemoryEventStore();
  bus = new InMemoryEventBus();

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
    announce: { events, bus, sessionIds: SESSIONS },
  });
}

/** Every event this close appended, per session. */
async function appended(sessionId: string) {
  return await events.readFrom(sessionId, 0);
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

describe("telling everyone watching that the preview has gone", () => {
  it("appends `preview.stopped` to every session in the project", async () => {
    // Every one of them, because the sandbox belonged to the project they share: a tab open
    // on the second conversation is showing the same dead address as a tab on the first.
    await close();

    for (const sessionId of SESSIONS) {
      expect(await appended(sessionId)).toMatchObject([{ type: "preview.stopped", payload: {} }]);
    }
  });

  it("publishes it, so an open tab does not have to reconnect to find out", async () => {
    const seen: string[] = [];
    for (const sessionId of SESSIONS) bus.subscribe(sessionId, (e) => seen.push(e.type));

    await close();

    expect(seen).toEqual(["preview.stopped", "preview.stopped"]);
  });

  it("says nothing when the close failed and the sandbox is still serving", async () => {
    // The preview is alive. Announcing that it stopped would send every open tab to an empty
    // pane over a snapshot upload the user never asked about.
    objects.failWith({ code: "unavailable", message: "R2 is not answering" });

    await close();

    for (const sessionId of SESSIONS) expect(await appended(sessionId)).toEqual([]);
  });

  it("announces an abandoned sandbox too", async () => {
    // The provider reclaimed it: nothing was snapshotted, but the preview is just as gone.
    await sandbox.destroy(sandboxId);

    await close();

    expect(await appended(SESSIONS[0] ?? "")).toMatchObject([{ type: "preview.stopped" }]);
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

describe("closing a project that a turn has already snapshotted", () => {
  it("points the project at the existing snapshot instead of writing a second one", async () => {
    // The ordinary case now: a turn snapshots its own work, and minutes later the reaper — or
    // the user — closes the project at the same commit. Capturing again would upload a
    // byte-identical bundle and leave the project with two rows describing one tree.
    await snapshots.record({
      projectId: PROJECT,
      key: "projects/p/from-the-turn.bundle",
      gitSha: SHA,
    });

    const result = await close();

    expect(result).toMatchObject({ outcome: "put_away", key: "projects/p/from-the-turn.bundle" });
    expect(objects.puts).toBe(0);
    expect(snapshots.all()).toHaveLength(1);
    // The row still has to name a snapshot that exists, or the next open restores from nothing.
    expect(projects.get(PROJECT)).toMatchObject({
      sandboxId: null,
      snapshotKey: "projects/p/from-the-turn.bundle",
    });
  });
});
