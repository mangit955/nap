import { foldJobs } from "./job-state.ts";
import type { StoredEvent } from "./ports/event-store.ts";

/**
 * The job and exact source range a new app test may inspect. No earlier job is substituted.
 *
 * `goal` is the job's goal rather than its objective: after **Fix it** the newest job's objective
 * is the repair instructions, and a test judged against those is judged against the wrong thing.
 */
export function appTestTarget(
  events: readonly StoredEvent[],
): { jobId: string; goal: string; commitSha: string; baseRevision: string } | undefined {
  const state = foldJobs(events);
  const job = state.jobs.at(-1);
  if (job?.phase !== "verified" || !job.checkpointSha || state.headSha !== job.checkpointSha)
    return undefined;
  const start = events.findIndex(
    (event) => event.type === "job.started" && event.payload.jobId === job.jobId,
  );
  const firstCommit = events
    .slice(start + 1)
    .find((event) => event.type === "turn.completed" && event.payload.commitSha !== null);
  if (firstCommit?.type !== "turn.completed" || firstCommit.payload.commitSha === null)
    return undefined;
  return {
    jobId: job.jobId,
    goal: job.goal,
    commitSha: job.checkpointSha,
    baseRevision: `${firstCommit.payload.commitSha}^`,
  };
}

/**
 * The goal the app test `testTurnId` was judged against, when it finished with a failed
 * assertion — which is what **Fix it** may repair, and what the job it opens is for.
 *
 * Read from the log, which only the runtime writes, so the goal a repair carries forward is never
 * words a client sent. `undefined` for a test that is not in this log, still running, or that
 * failed nothing.
 */
export function failedAppTestGoal(
  events: readonly StoredEvent[],
  testTurnId: string,
): string | undefined {
  let goal: string | undefined;
  for (const event of events) {
    if (event.turnId !== testTurnId) continue;
    if (event.type === "test.started") goal = event.payload.objective;
    if (event.type === "test.completed") return event.payload.counts.failed > 0 ? goal : undefined;
  }
  return undefined;
}
