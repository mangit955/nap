import { foldJobs } from "./job-state.ts";
import type { StoredEvent } from "./ports/event-store.ts";

/** The job and exact source range a new app test may inspect. No earlier job is substituted. */
export function appTestTarget(
  events: readonly StoredEvent[],
): { jobId: string; objective: string; commitSha: string; baseRevision: string } | undefined {
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
    objective: job.objective,
    commitSha: job.checkpointSha,
    baseRevision: `${firstCommit.payload.commitSha}^`,
  };
}
