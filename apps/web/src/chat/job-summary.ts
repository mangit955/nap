/**
 * What the workspace bar says about the job in front of you: its phase, in a word.
 *
 * A job's phase is *status*, not chronology — it describes the project right now, and the next
 * event answers it again. Folding it into the transcript would put a running commentary of the
 * same fact through a pane that reads as a conversation, so the transcript draws none of it and
 * the bar does (`transcript.ts`).
 *
 * The newest job is the only one described. Jobs are serial — a session runs one turn at a time
 * — so the newest is either the one in flight or the last thing that happened, and showing an
 * older one would be describing a project that has moved on.
 */

import { foldJobs, isJobOpen, type JobPhase, type SessionJobs } from "@nap/shared/job-state";
import type { StoredEvent } from "@nap/shared/ports/event-store";

export type JobSummary = {
  phase: JobPhase;
  /** The phase in a word, for the bar. */
  phaseLabel: string;
  /** Whether the phase is one the job can still leave, which is what earns a live pulse. */
  open: boolean;
};

const PHASE_LABELS: Record<JobPhase, string> = {
  working: "Working",
  verifying: "Verifying",
  repairing: "Repairing",
  verified: "Verified",
  unverified: "Unverified",
  exhausted: "Out of repairs",
  abandoned: "Abandoned",
};

/** What the workspace knows about this session's jobs: all of them, and the newest described. */
export type SessionJobView = {
  state: SessionJobs;
  /** The newest job, or `null` for a session nothing has been asked of. */
  summary: JobSummary | null;
};

/** Derived once, for the workspace. See `useSessionLog`. */
export function jobView(events: readonly StoredEvent[]): SessionJobView {
  const state = foldJobs(events);
  return { state, summary: jobSummary(state) };
}

export function jobSummary(state: SessionJobs): JobSummary | null {
  const job = state.jobs.at(-1);
  if (job === undefined) return null;

  return { phase: job.phase, phaseLabel: PHASE_LABELS[job.phase], open: isJobOpen(job) };
}
