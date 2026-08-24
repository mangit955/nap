import { InMemoryCapacityReconciler } from "@nap/db/testing/in-memory-capacity-reconciler";
import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemoryProjectSandboxStore } from "@nap/db/testing/in-memory-project-sandbox-store";
import { InMemorySandboxCapacity } from "@nap/db/testing/in-memory-sandbox-capacity";
import { InMemorySnapshotStore } from "@nap/db/testing/in-memory-snapshot-store";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { scriptGit } from "@nap/sandbox/testing/script-git";
import type { IdleProject } from "@nap/shared/ports/project-sandbox-store";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { beforeEach, describe, expect, it } from "vitest";
import { sweepIdleProjects } from "./reaper.ts";

const PROJECT = "3e0fbc41-6f5d-4a8e-ab9c-4d5e6f708192";
const SESSION = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";
const SHA = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f80912";
const USER = "8f0a1b2c-3d4e-4f50-9a6b-7c8d9e0f1a2b";

/** The clock every test reads, so "an hour ago" is a fixed number rather than a real wait. */
const NOW = Date.UTC(2026, 7, 9, 12, 0, 0);
const IDLE_MS = 10 * 60 * 1000;
const HOUR_AGO_MS = NOW - 60 * 60 * 1000;
const HOUR_AGO = new Date(HOUR_AGO_MS).toISOString();
const MINUTE_AGO = new Date(NOW - 60 * 1000).toISOString();

let sandbox: InMemorySandboxManager;
let objects: InMemoryObjectStore;
let snapshots: InMemorySnapshotStore;
let projects: InMemoryProjectSandboxStore;
let events: InMemoryEventStore;
let sandboxId: string;

beforeEach(async () => {
  // Every sandbox in this file starts an hour before the sweep's clock, so nothing is caught by
  // the reconciliation pass's grace window for creations still in flight.
  sandbox = scriptGit(new InMemorySandboxManager({ now: () => HOUR_AGO_MS }), { sha: SHA });
  objects = new InMemoryObjectStore();
  snapshots = new InMemorySnapshotStore();
  events = new InMemoryEventStore();

  const created = await sandbox.create(PROJECT);
  if (!created.ok) throw new Error("could not create a sandbox");
  sandboxId = created.value.id;

  projects = new InMemoryProjectSandboxStore([
    { projectId: PROJECT, sandboxId, sessionIds: [SESSION], lastActiveAt: HOUR_AGO },
  ]);
});

function sweep(
  overrides: {
    isBusy?: (project: IdleProject) => Promise<boolean>;
    capacity?: InMemorySandboxCapacity;
    reconcile?: InMemoryCapacityReconciler;
  } = {},
) {
  return sweepIdleProjects({
    projects,
    sandbox,
    objects,
    snapshots,
    idleMs: IDLE_MS,
    ...(overrides.capacity === undefined ? {} : { capacity: overrides.capacity }),
    ...(overrides.reconcile === undefined
      ? {}
      : { reconcile: { reconciler: overrides.reconcile, inventory: sandbox } }),
    isBusy: overrides.isBusy ?? (async () => false),
    now: () => NOW,
    announce: { events, bus: new InMemoryEventBus() },
  });
}

describe("reaping an idle project", () => {
  it("gives back the capacity its sandbox was occupying", async () => {
    // The sweep is where most sandboxes end, so it is the main way capacity ever comes back: a
    // ceiling nothing released would count every project this cluster had ever opened.
    const capacity = new InMemorySandboxCapacity();
    const reserved = await capacity.reserve({ projectId: PROJECT, userId: USER });
    if (reserved.ok) await capacity.activate(reserved.value.id, sandboxId);

    await sweep({ capacity });

    expect(capacity.held()).toEqual([]);
  });

  it("snapshots it and destroys the sandbox", async () => {
    const result = await sweep();

    expect(result.reaped).toEqual([PROJECT]);
    expect(objects.keys()).toHaveLength(1);
    expect(snapshots.all()).toHaveLength(1);
    await expect(sandbox.resume(sandboxId)).resolves.toMatchObject({
      ok: false,
      error: { code: "destroyed" },
    });
  });

  it("clears the recorded sandbox and points the project at the snapshot", async () => {
    // Left recorded, the next turn tries to resume a sandbox that no longer exists and the
    // recovery path warns the user their work may be gone — when the snapshot is current.
    await sweep();

    const project = projects.get(PROJECT);
    expect(project?.sandboxId).toBeNull();
    expect(project?.snapshotKey).toBe(snapshots.all()[0]?.key);
  });

  it("tells the project's sessions their preview has stopped", async () => {
    // The sweep is the case this exists for: nobody pressed anything, so a tab left open is
    // showing a live-looking app at an address that has just stopped answering.
    await sweep();

    expect(await events.readFrom(SESSION, 0)).toMatchObject([{ type: "preview.stopped" }]);
  });

  it("leaves a project that was active inside the window alone", async () => {
    projects.touch(PROJECT, MINUTE_AGO);

    const result = await sweep();

    expect(result.reaped).toEqual([]);
    expect(objects.keys()).toEqual([]);
    await expect(sandbox.resume(sandboxId)).resolves.toMatchObject({ ok: true });
  });
});

describe("a project with a turn in flight", () => {
  it("is never reaped, however idle the log says it is", async () => {
    // The assertion `docs/PLAN.md` §4 calls this task's reason to exist. Destroying a sandbox
    // mid-turn takes the workspace out from under an agent that is writing to it.
    const result = await sweep({ isBusy: async () => true });

    expect(result.reaped).toEqual([]);
    expect(result.skipped).toEqual([PROJECT]);
    await expect(sandbox.resume(sandboxId)).resolves.toMatchObject({ ok: true });
  });

  it("is asked about by its own sessions", async () => {
    // Turns are tracked per session and sandboxes belong to projects, so the check has to be
    // handed the sessions — a caller that could only see the project id could not answer it.
    const asked: string[][] = [];

    await sweep({
      isBusy: async (project) => {
        asked.push(project.sessionIds);
        return false;
      },
    });

    expect(asked).toEqual([[SESSION]]);
  });

  it("takes no snapshot at all, rather than one it then keeps", async () => {
    await sweep({ isBusy: async () => true });

    expect(objects.keys()).toEqual([]);
    expect(snapshots.all()).toEqual([]);
  });
});

describe("when something goes wrong", () => {
  it("defers destruction when the snapshot cannot be uploaded", async () => {
    objects.failWith({ code: "unavailable", message: "R2 is not answering" });

    const result = await sweep();

    // The sandbox is the only copy of the project until the upload lands. A reaper that
    // destroyed it anyway would turn an outage into deleted work.
    expect(result.reaped).toEqual([]);
    expect(result.failed).toMatchObject([{ projectId: PROJECT, reason: "upload_failed" }]);
    await expect(sandbox.resume(sandboxId)).resolves.toMatchObject({ ok: true });
  });

  it("leaves the project recorded as holding its sandbox when the teardown failed", async () => {
    objects.failWith({ code: "unavailable", message: "R2 is not answering" });

    await sweep();

    // So the next sweep tries again, rather than losing track of a sandbox still being billed.
    expect(projects.get(PROJECT)?.sandboxId).toBe(sandboxId);
  });

  it("reports a project whose row could not be updated without failing the sweep", async () => {
    projects.failWith(new Error("connection terminated"));

    const result = await sweep();

    expect(result.failed).toMatchObject([{ projectId: PROJECT, reason: "release_failed" }]);
  });

  it("carries on with the rest after one project cannot be handled", async () => {
    // One project in trouble must not leave every other sandbox running and billing.
    const second = await sandbox.create("6b7c8d9e-0f1a-4b2c-8d3e-4f5a6b7c8d9e");
    if (!second.ok) throw new Error("could not create a second sandbox");
    projects = new InMemoryProjectSandboxStore([
      { projectId: PROJECT, sandboxId: "gone", sessionIds: [SESSION], lastActiveAt: HOUR_AGO },
      {
        projectId: "6b7c8d9e-0f1a-4b2c-8d3e-4f5a6b7c8d9e",
        sandboxId: second.value.id,
        lastActiveAt: HOUR_AGO,
      },
    ]);

    const result = await sweep();

    expect(result.abandoned).toEqual([PROJECT]);
    expect(result.reaped).toEqual(["6b7c8d9e-0f1a-4b2c-8d3e-4f5a6b7c8d9e"]);
  });
});

describe("a sandbox that is already gone", () => {
  it("stops pointing the project at it, without inventing a snapshot", async () => {
    // Providers reclaim sandboxes on their own timers, so a row outlives the thing it names.
    // Retried forever, this is a sweep that fails every tick and a project nobody can clean
    // up; released, it simply restores from whatever snapshot it already had.
    await sandbox.destroy(sandboxId);

    const result = await sweep();

    expect(result.abandoned).toEqual([PROJECT]);
    expect(result.failed).toEqual([]);
    expect(projects.get(PROJECT)?.sandboxId).toBeNull();
  });

  it("keeps the snapshot the project already had", async () => {
    // That row may point at the last surviving copy of the project. Overwriting it with a
    // snapshot that was never taken would destroy the thing this whole area exists to protect.
    projects = new InMemoryProjectSandboxStore([
      {
        projectId: PROJECT,
        sandboxId: "gone",
        snapshotKey: "projects/p/earlier.bundle",
        lastActiveAt: HOUR_AGO,
      },
    ]);

    await sweep();

    expect(projects.get(PROJECT)?.snapshotKey).toBe("projects/p/earlier.bundle");
  });
});

describe("reconciling capacity", () => {
  it("does not reconcile at all unless the composition asked for it", async () => {
    // "Nothing was stranded" and "nothing looked" are different answers, and a deployment
    // reading a steady zero it never asked for would draw the happier of the two conclusions.
    const result = await sweep();

    expect(result.reconciled).toBeUndefined();
  });

  it("reports the slots the database reclaimed", async () => {
    const reconcile = new InMemoryCapacityReconciler({
      reclaimed: { expired: ["r-died-mid-creation"], orphaned: ["r-sandbox-vanished"] },
      referenced: [sandboxId],
    });

    const result = await sweep({ reconcile });

    expect(result.reconciled).toMatchObject({
      expired: ["r-died-mid-creation"],
      orphaned: ["r-sandbox-vanished"],
    });
  });

  it("destroys a sandbox the provider is running that nothing references", async () => {
    // The failure boundary that needs the provider: creation succeeded and recording it did
    // not, so this sandbox is billed under an id that appears in no row anywhere.
    const leaked = await sandbox.create("6b7c8d9e-0f1a-4b2c-8d3e-4f5a6b7c8d9e");
    if (!leaked.ok) throw new Error("could not create a sandbox");

    const result = await sweep({ reconcile: new InMemoryCapacityReconciler({ referenced: [] }) });

    expect(result.reconciled?.destroyed).toEqual([leaked.value.id]);
  });

  it("still reconciles after a project could not be put away", async () => {
    // They are two jobs on one timer, and the expensive one is the sweep. A leaked slot must
    // not wait on a project whose snapshot upload keeps failing.
    objects.failWith({ code: "unavailable", message: "R2 is not answering" });
    const reconcile = new InMemoryCapacityReconciler({ referenced: [sandboxId] });

    const result = await sweep({ reconcile });

    expect(result.failed).toHaveLength(1);
    expect(reconcile.reclaimCalls()).toBe(1);
  });

  it("reconciles after the projects, not before", async () => {
    // Putting a project away is what releases its reservation and clears the sandbox it named,
    // so reconciling first would be reading the state of the previous tick.
    const swept = await sweep({ reconcile: new InMemoryCapacityReconciler({ referenced: [] }) });

    // The project's own sandbox was destroyed by the sweep, so the provider no longer lists it
    // and the pass that would otherwise have found it unreferenced has nothing to do.
    expect(swept.reaped).toEqual([PROJECT]);
    expect(swept.reconciled?.destroyed).toEqual([]);
  });
});
