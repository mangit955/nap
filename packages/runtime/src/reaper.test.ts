import { InMemoryEventBus } from "@nap/db/testing/in-memory-event-bus";
import { InMemoryEventStore } from "@nap/db/testing/in-memory-event-store";
import { InMemoryProjectSandboxStore } from "@nap/db/testing/in-memory-project-sandbox-store";
import { InMemorySnapshotStore } from "@nap/db/testing/in-memory-snapshot-store";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { scriptGit } from "@nap/sandbox/testing/script-git";
import type { IdleProject } from "@nap/shared/ports/project-sandbox-store";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startReaper, sweepIdleProjects } from "./reaper.ts";

const PROJECT = "3e0fbc41-6f5d-4a8e-ab9c-4d5e6f708192";
const SESSION = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";
const SHA = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f80912";

/** The clock every test reads, so "an hour ago" is a fixed number rather than a real wait. */
const NOW = Date.UTC(2026, 7, 9, 12, 0, 0);
const IDLE_MS = 10 * 60 * 1000;
const HOUR_AGO = new Date(NOW - 60 * 60 * 1000).toISOString();
const MINUTE_AGO = new Date(NOW - 60 * 1000).toISOString();

let sandbox: InMemorySandboxManager;
let objects: InMemoryObjectStore;
let snapshots: InMemorySnapshotStore;
let projects: InMemoryProjectSandboxStore;
let events: InMemoryEventStore;
let sandboxId: string;

beforeEach(async () => {
  sandbox = scriptGit(new InMemorySandboxManager(), { sha: SHA });
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

function sweep(overrides: { isBusy?: (project: IdleProject) => boolean } = {}) {
  return sweepIdleProjects({
    projects,
    sandbox,
    objects,
    snapshots,
    idleMs: IDLE_MS,
    isBusy: overrides.isBusy ?? (() => false),
    now: () => NOW,
    announce: { events, bus: new InMemoryEventBus() },
  });
}

describe("reaping an idle project", () => {
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
    const result = await sweep({ isBusy: () => true });

    expect(result.reaped).toEqual([]);
    expect(result.skipped).toEqual([PROJECT]);
    await expect(sandbox.resume(sandboxId)).resolves.toMatchObject({ ok: true });
  });

  it("is asked about by its own sessions", async () => {
    // Turns are tracked per session and sandboxes belong to projects, so the check has to be
    // handed the sessions — a caller that could only see the project id could not answer it.
    const asked: string[][] = [];

    await sweep({
      isBusy: (project) => {
        asked.push(project.sessionIds);
        return false;
      },
    });

    expect(asked).toEqual([[SESSION]]);
  });

  it("takes no snapshot at all, rather than one it then keeps", async () => {
    await sweep({ isBusy: () => true });

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

describe("the schedule", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * The schedule takes the sweep as a dependency rather than building one, so these tests are
   * about ticking and nothing else — no sandbox, no store, and no back door into the reaper
   * that production does not use.
   */
  function counting(): { sweep: () => Promise<void>; calls: () => number } {
    let calls = 0;
    return {
      calls: () => calls,
      sweep: async () => {
        calls += 1;
      },
    };
  }

  it("does not sweep the moment it starts", () => {
    const { sweep, calls } = counting();

    const reaper = startReaper({ intervalMs: 60_000, sweep });

    expect(calls()).toBe(0);
    reaper.stop();
  });

  it("sweeps on every tick", async () => {
    const { sweep, calls } = counting();
    const reaper = startReaper({ intervalMs: 60_000, sweep });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls()).toBe(2);

    reaper.stop();
  });

  it("leaves no timer behind when stopped", () => {
    // Asserted on the resource rather than on a flag: a `stopped` boolean that suppresses the
    // work still leaks the interval, and the process never exits.
    const reaper = startReaper({ intervalMs: 60_000, sweep: counting().sweep });

    reaper.stop();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("skips a tick that lands while the previous sweep is still running", async () => {
    // A sweep talks to sandboxes and an object store over the network; two overlapping would
    // try to tear the same project down twice.
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const reaper = startReaper({
      intervalMs: 60_000,
      sweep: () => {
        calls += 1;
        return blocked;
      },
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(1);

    release();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(2);

    reaper.stop();
  });

  it("keeps sweeping after one fails, and reports it", async () => {
    // An unhandled rejection ends the Bun process, which would turn one bad sweep into an
    // outage for every open tab.
    const failures: unknown[] = [];
    let calls = 0;
    const reaper = startReaper({
      intervalMs: 60_000,
      sweep: () => {
        calls += 1;
        return Promise.reject(new Error("the database went away"));
      },
      onError: (error) => failures.push(error),
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(calls).toBe(2);
    expect(failures).toHaveLength(2);
    reaper.stop();
  });
});
