/**
 * Putting away the projects nobody is looking at.
 *
 * A sandbox is billed for every second it exists, and most of them spend most of their life
 * idle. This sweeps them: for each project whose newest activity is older than the threshold,
 * snapshot it, destroy the sandbox, and record that the project no longer has one — after
 * which the next turn restores it, which is why any of this is safe.
 *
 * **It adds no rules of its own about how a project is put away.** That whole operation —
 * snapshot, destroy, record — is `putProjectAway`, which the close endpoint calls too, so the
 * two cannot drift. What this file owns is *which* projects and *when*.
 *
 * **The busy check is a filter, not a lock.** A turn that starts in the moment between the
 * check and the destroy still finds its sandbox gone. That is acceptable and the alternative
 * is not: with restore in place, the cost of losing the race is a turn that takes a few
 * seconds longer while the project is restored from the snapshot this just took. Holding a
 * lock across a teardown, on the other hand, means a wedged sweep can block turns.
 *
 * One project's failure never stops the sweep. The whole point is that a sandbox nobody
 * released keeps costing money, and the project that failed is exactly the one most likely to
 * fail again next time.
 *
 * **It also reconciles capacity, which is a different job on the same timer.** Sweeping is about
 * projects that are idle; reconciling is about slots of the ceiling that no path gave back — a
 * process that died mid-creation, a sandbox running under an id the database never recorded. They
 * share this schedule because both are "come past occasionally and put things right", and both
 * heal in minutes rather than never. See `reconcileCapacity` for the three boundaries.
 */

import type { CapacityReconciler } from "@nap/shared/ports/capacity-reconciler";
import type { EventBus } from "@nap/shared/ports/event-bus";
import type { EventStore } from "@nap/shared/ports/event-store";
import type { ObjectStore } from "@nap/shared/ports/object-store";
import type { IdleProject, ProjectSandboxStore } from "@nap/shared/ports/project-sandbox-store";
import type { SandboxCapacity } from "@nap/shared/ports/sandbox-capacity";
import type { SandboxInventory } from "@nap/shared/ports/sandbox-inventory";
import type { SandboxManager } from "@nap/shared/ports/sandbox-manager";
import type { SnapshotStore } from "@nap/shared/ports/snapshot-store";
import { putProjectAway } from "./close-project.ts";
import { type ReconcileResult, reconcileCapacity } from "./reconcile-capacity.ts";

export type SweepFailure = {
  projectId: string;
  /** Whatever `putProjectAway` reported — a teardown reason, or a failed row update. */
  reason: string;
  message: string;
};

export type SweepResult = {
  /**
   * What the reconciliation pass gave back, when the composition asked for one.
   *
   * Absent rather than empty when it did not: "nothing was stranded" and "nothing looked" are
   * different answers, and a deployment reading a steady zero it never asked for would draw the
   * happier of the two conclusions.
   */
  reconciled?: ReconcileResult;
  /** Projects snapshotted, destroyed and released, in the order they were handled. */
  reaped: string[];
  /** Projects left alone because a turn was running. */
  skipped: string[];
  /**
   * Projects whose sandbox was already gone, so there was nothing to snapshot and the
   * reference was simply dropped. Not a failure and not a success — worth its own count,
   * because a number that keeps climbing means something else is killing sandboxes first.
   */
  abandoned: string[];
  failed: SweepFailure[];
};

export type SweepOptions = {
  projects: ProjectSandboxStore;
  sandbox: SandboxManager;
  objects: ObjectStore;
  snapshots: SnapshotStore;
  /** How long a project must have been quiet before its sandbox is put away. */
  idleMs: number;
  /**
   * Where a swept project's sandbox capacity goes back to. Absent means the deployment is
   * uncapped; see `putProjectAway`, which owns what happens with it.
   */
  capacity?: SandboxCapacity;
  /**
   * Whether a turn is running for any of the project's sessions. Injected because turns are
   * tracked by whatever is serving requests, and this package has no idea what that is.
   */
  isBusy: (project: IdleProject) => boolean;
  /** Injected so a test can place "an hour ago" exactly rather than waiting for one. */
  now?: () => number;
  /**
   * How to put back the capacity no ordinary path gave back, if this deployment can.
   *
   * Optional for the same reason `capacity` is — a composition may be uncapped — and separate
   * from it because it needs two things the sweep otherwise has no use for: a reconciler that
   * can read the reservations table, and an inventory of what the provider is really running.
   * Absent, the sweep still sweeps and a leak still costs a slot until the process restarts.
   */
  reconcile?: { reconciler: CapacityReconciler; inventory: SandboxInventory };
  /**
   * Where to announce that a swept project's preview has stopped.
   *
   * The sessions to tell come from each candidate, so this is only the log to write to.
   * Optional, like `putProjectAway`'s own: a sweep with nowhere to announce still sweeps.
   */
  announce?: { events: EventStore; bus: EventBus };
};

export async function sweepIdleProjects(options: SweepOptions): Promise<SweepResult> {
  const now = options.now ?? Date.now;
  const cutoff = new Date(now() - options.idleMs).toISOString();

  const result: SweepResult = { reaped: [], skipped: [], abandoned: [], failed: [] };
  const candidates = await options.projects.idleSince(cutoff);

  for (const project of candidates) {
    if (options.isBusy(project)) {
      result.skipped.push(project.projectId);
      continue;
    }

    const closed = await putProjectAway({
      projects: options.projects,
      sandbox: options.sandbox,
      objects: options.objects,
      snapshots: options.snapshots,
      projectId: project.projectId,
      sandboxId: project.sandboxId,
      ...(options.capacity === undefined ? {} : { capacity: options.capacity }),
      ...(options.announce === undefined
        ? {}
        : { announce: { ...options.announce, sessionIds: project.sessionIds } }),
    });

    if (closed.outcome === "put_away") result.reaped.push(project.projectId);
    else if (closed.outcome === "abandoned") result.abandoned.push(project.projectId);
    else {
      result.failed.push({
        projectId: project.projectId,
        reason: closed.reason,
        message: closed.message,
      });
    }
  }

  // After the projects, deliberately. Putting a project away releases its reservation and clears
  // the sandbox it named, so reconciling afterwards sees this tick's work rather than last
  // tick's — and a sandbox this sweep has just destroyed is gone from the provider's list too.
  if (options.reconcile !== undefined) {
    result.reconciled = await reconcileCapacity({
      reconciler: options.reconcile.reconciler,
      inventory: options.reconcile.inventory,
      sandbox: options.sandbox,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }

  return result;
}

export type ReaperSchedule = {
  intervalMs: number;
  /** What to run on each tick — normally a closure over `sweepIdleProjects`. */
  sweep: () => Promise<unknown>;
  onError?: (error: unknown) => void;
};

/**
 * Runs a sweep every `intervalMs`, forever, without ever rejecting.
 *
 * Two things are load-bearing. **A tick that lands while the previous sweep is still running
 * is skipped** — sweeps talk to sandboxes and an object store over the network, and two
 * overlapping ones would try to tear the same project down twice. And **nothing here throws**:
 * an unhandled rejection ends the Bun process, which would turn one bad sweep into an outage
 * for every open tab.
 *
 * The first sweep is one interval away rather than immediate, so a process that is restarting
 * repeatedly does not tear down a project on every boot.
 */
export function startReaper(schedule: ReaperSchedule): { stop: () => void } {
  let running = false;

  const timer = setInterval(() => {
    if (running) return;
    running = true;

    void schedule
      .sweep()
      .catch((error: unknown) => schedule.onError?.(error))
      .finally(() => {
        running = false;
      });
  }, schedule.intervalMs);

  // Never a reason to hold the process open by itself; the server is what keeps it alive.
  timer.unref?.();

  return {
    stop: () => clearInterval(timer),
  };
}
