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
 */

import type { EventBus } from "@nap/shared/ports/event-bus";
import type { EventStore } from "@nap/shared/ports/event-store";
import type { ObjectStore } from "@nap/shared/ports/object-store";
import type { PageCapture } from "@nap/shared/ports/page-capture";
import type { IdleProject, ProjectSandboxStore } from "@nap/shared/ports/project-sandbox-store";
import type { SandboxManager } from "@nap/shared/ports/sandbox-manager";
import type { SnapshotStore } from "@nap/shared/ports/snapshot-store";
import { putProjectAway } from "./close-project.ts";

export type SweepFailure = {
  projectId: string;
  /** Whatever `putProjectAway` reported — a teardown reason, or a failed row update. */
  reason: string;
  message: string;
};

export type SweepResult = {
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
   * A browser, so a project swept while nobody was looking still leaves a picture behind.
   *
   * Threaded through to `putProjectAway` rather than used here: a sweep is a close that nobody
   * asked for, and the two must not differ in what they leave behind.
   */
  capture?: PageCapture;
  /**
   * Whether a turn is running for any of the project's sessions. Injected because turns are
   * tracked by whatever is serving requests, and this package has no idea what that is.
   */
  isBusy: (project: IdleProject) => boolean;
  /** Injected so a test can place "an hour ago" exactly rather than waiting for one. */
  now?: () => number;
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
      ...(options.capture === undefined ? {} : { capture: options.capture }),
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
