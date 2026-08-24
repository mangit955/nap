/**
 * What the workspace says about the job in front of you — in the strip above the chat, and in
 * the bar overhead that keeps saying it once the chat is collapsed.
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
import {
  foldJobs,
  isJobOpen,
  type JobPhase,
  MAX_REPAIR_ATTEMPTS,
  type SessionJobs,
} from "@nap/shared/job-state";
import type { StoredEvent } from "@nap/shared/ports/event-store";

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

/**
 * The phase in a word, shared with the history below the strip.
 *
 * Exported so there is one vocabulary rather than two: a job reading `Out of repairs` in the
 * strip must not read `Exhausted` one line down in the list of past jobs.
 */
export const PHASE_LABELS: Record<JobPhase, string> = {
  working: "Working",
  verifying: "Verifying",
  repairing: "Repairing",
  verified: "Verified",
  unverified: "Unverified",
  exhausted: "Out of repairs",
  abandoned: "Abandoned",
};

/**
 * What the workspace knows about this session's jobs: all of them, and the newest one described.
 *
 * The pair travels as one value because two surfaces read it — the strip inside the chat pane,
 * and the bar above it that stays when the chat is collapsed. Handing them the fold and letting
 * each describe the newest job for itself would work only for as long as the description stayed
 * pure; one value cannot disagree with itself at all.
 */
export type SessionJobView = {
  state: SessionJobs;
  /** The newest job, or `null` for a session nothing has been asked of. */
  summary: JobSummary | null;
};

/** Derived once, above both panes that read it. See `useSessionLog`. */
export function jobView(events: readonly StoredEvent[]): SessionJobView {
  const state = foldJobs(events);
  return { state, summary: jobSummary(state) };
}

export function jobSummary(state: SessionJobs): JobSummary | null {
  const job = state.jobs.at(-1);
  if (job === undefined) return null;

  return {
    phase: job.phase,
    phaseLabel: PHASE_LABELS[job.phase],
    open: isJobOpen(job),
    checks: job.checks,
    attemptsLabel: repairsLabel(job.attemptsUsed),
    state: stateLine(state, job.checks),
  };
}

/**
 * Repairs spent, or `null` when none have been.
 *
 * Out of the total rather than alone: "1 repair" is a number with nothing to read it against,
 * where "1 of 3" says both what has happened and how much room is left. Shared with the history
 * for the reason `PHASE_LABELS` is.
 */
export function repairsLabel(attemptsUsed: number): string | null {
  if (attemptsUsed === 0) return null;
  return `${attemptsUsed} of ${MAX_REPAIR_ATTEMPTS} repairs used`;
}

/**
 * A commit as somebody would type it, or nothing at all.
 *
 * Git's own abbreviation, and here beside the other shared wording for the reason `PHASE_LABELS`
 * is: three places now show one — a history entry, the control that expands the history, and the
 * card that says what was decided in your absence — and two of them abbreviating the same commit
 * differently would read as two commits.
 */
export function shortSha(sha: string | null): string | null {
  return sha === null ? null : sha.slice(0, SHORT_SHA);
}

/** Git's own abbreviation. */
const SHORT_SHA = 7;

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
