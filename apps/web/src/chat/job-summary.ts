/**
 * What the strip above the chat says about the job in front of you.
 *
 * A job's phase, its checks and where its commits stand are *status*, not chronology — they
 * describe the project right now, and every one of them is answered again by the next event.
 * Folding them into the transcript would put a running commentary of the same four facts
 * through a pane that reads as a conversation, so the transcript draws none of them and this
 * does (`transcript.ts`).
 *
 * Pure, and the sentences are here rather than in the component for the reason the rest of this
 * app puts its wording in a module: the honest line is easy to get subtly wrong, the wrong
 * version of it is a claim about whether somebody's project works, and a claim is worth a test.
 *
 * The newest job is the only one described. Jobs are serial — a session runs one turn at a time
 * — so the newest is either the one in flight or the last thing that happened, and a strip
 * showing an older one would be describing a project that has moved on.
 */

import type { VerifiedCheck } from "@nap/shared/events";
import { type JobPhase, MAX_REPAIR_ATTEMPTS, type SessionJobs } from "@nap/shared/job-state";

export type JobSummary = {
  phase: JobPhase;
  /** The phase in a word, for the strip's face. */
  phaseLabel: string;
  /** Whether the phase is one the job can still leave, which is what earns a live pulse. */
  open: boolean;
  /** The newest verification's findings, in the order they were discovered. Empty until one. */
  checks: readonly VerifiedCheck[];
  /** Repairs spent, or `null` when none has been and none is owed. */
  attemptsLabel: string | null;
  /** `HEAD == last checkpoint`, said in one sentence somebody can act on. */
  state: string;
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

const OPEN_PHASES: readonly JobPhase[] = ["working", "verifying", "repairing"];

export function jobSummary(state: SessionJobs): JobSummary | null {
  const job = state.jobs.at(-1);
  if (job === undefined) return null;

  return {
    phase: job.phase,
    phaseLabel: PHASE_LABELS[job.phase],
    open: OPEN_PHASES.includes(job.phase),
    checks: job.checks,
    attemptsLabel:
      job.attemptsUsed === 0 ? null : `${job.attemptsUsed} of ${MAX_REPAIR_ATTEMPTS} repairs used`,
    state: stateLine(state, job.checks),
  };
}

/**
 * Whether this project is in a state something has checked.
 *
 * Four sentences, and the *third* is the one this function exists for. A verification whose
 * checks all came back absent is folded as `verified` — an unasked check is not a failed one
 * (`docs/adr/0002`), and the alternative puts every project without a full complement of
 * scripts into a repair loop it cannot leave — but the commit it checkpointed was checked by
 * nothing, and a strip reading "verified" over it would be the system claiming to have found
 * something it never looked for. So the fold's answer is kept and the sentence says what
 * actually happened.
 *
 * A short-circuited run cannot reach this case: the check that stopped it is `failed`, so a run
 * with any red in it has a non-absent outcome and lands on the last line instead.
 */
function stateLine(state: SessionJobs, checks: readonly VerifiedCheck[]): string {
  if (state.headSha === null) return "Nothing committed yet.";

  if (state.atCheckpoint) {
    if (checks.length > 0 && checks.every((check) => check.outcome === "absent")) {
      return "This project declares no checks, so nothing was verified.";
    }
    return "At a verified state — the last commit passed the project's checks.";
  }

  if (state.checkpointSha === null) {
    return "Not verified — nothing committed here has passed the project's checks yet.";
  }

  return "Not verified — the last commit is ahead of the last checkpoint.";
}
