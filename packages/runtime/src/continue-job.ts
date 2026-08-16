/**
 * What to do about a job that is still open when its project is next opened.
 *
 * A process restart leaves a job open rather than failing it (`CONTEXT.md`, *Continue*), and
 * this is the reading of the log that decides what "continuing" means for the state it stopped
 * in. There is no supervisor and no jobs index: opening the project folds the log, and one of
 * four answers comes out.
 *
 * **Pure, and separate from the runtime on purpose.** Whether opening a project spends tokens
 * is the expensive question here — a crash loop that auto-continues is a bill — so it is
 * answerable by reading a table of inputs rather than by tracing an orchestrator. Nothing here
 * runs a check, starts a turn or touches a sandbox.
 *
 * Three judgements are worth stating out loud.
 *
 * **A recorded failure is repaired from, not re-run.** The commit has not moved since the checks
 * said no, so re-running them would learn the same thing at the cost of a whole verification —
 * and worse, `foldJobs` counts repair attempts from verification rounds, so a second round
 * against the same commit would silently spend one of the three. The failure the log kept is
 * enough to prompt the repair.
 *
 * **A round begun and unanswered is finished, not begun again.** Same arithmetic, other
 * direction: `verification.started` is already in the log, so continuing must not write a
 * second one. That is what `announce` says.
 *
 * **Nothing is verified twice.** A job sitting at a commit that is already a checkpoint has
 * nothing left to ask, and one whose turn never committed has nothing to ask about.
 */

import type { JobOutcome } from "@nap/shared/events";
import { openJob, type SessionJobs } from "@nap/shared/job-state";
import type { FailedAttempt } from "@nap/shared/ports/context-engine";
import type { CheckFailure } from "./verify-turn.ts";

/**
 * Where the failure being repaired came from, in place of the exit code a live run would give.
 *
 * The event log keeps a check's name, outcome and output but not its `detail`, and a repair
 * prompt reads that back in prose. Saying when it was found is more use to the model than a
 * reconstructed exit code would be: the run is over and the sandbox it ran in is gone.
 */
export const RECORDED_DETAIL = "recorded before this project was last put away";

export type JobContinuation =
  /** Nothing is open, or what is open has already reached the answer it existed to get. */
  | { kind: "none" }
  /** Open, but with nothing left to do — close it and say so. */
  | { kind: "close"; jobId: string; outcome: JobOutcome }
  /**
   * There is a commit nothing has checked. Run the checks against it and carry on from the
   * verdict, exactly as the turn that made it would have.
   */
  | {
      kind: "verify";
      jobId: string;
      objective: string;
      commitSha: string;
      /** Whether to write `verification.started`; false when the log already has this round's. */
      announce: boolean;
      /** Repair turns already spent, so the budget continues rather than restarting. */
      attemptsUsed: number;
      /** Failures already responded to, for the next prompt. */
      attempts: readonly FailedAttempt[];
    }
  /** The checks said no and there are attempts left. Prompt the repair the crash interrupted. */
  | {
      kind: "repair";
      jobId: string;
      objective: string;
      failed: CheckFailure;
      attemptsUsed: number;
      attempts: readonly FailedAttempt[];
    };

export function continuationFor(state: SessionJobs): JobContinuation {
  const job = openJob(state);
  if (job === undefined) return { kind: "none" };

  const { jobId, objective, attemptsUsed } = job;

  if (job.phase === "repairing") {
    const failed = job.checks.find((check) => check.outcome === "failed");

    // A `repairing` phase is one the fold derived from a red check, so this cannot be missing.
    // Closed rather than trusted not to happen: a job left open with nothing to repair is one
    // that every subsequent opening of this project would try to continue, forever.
    if (failed === undefined) return { kind: "close", jobId, outcome: "abandoned" };

    return {
      kind: "repair",
      jobId,
      objective,
      failed: { name: failed.name, detail: RECORDED_DETAIL, output: failed.output },
      attemptsUsed,
      // The failure below is the one being repaired now, which the caller records as it goes;
      // the rounds before it are not in the fold, which keeps only the newest findings.
      attempts: [],
    };
  }

  const commitSha = state.headSha;

  // Nothing was committed, so there is no claim to arbitrate — the same reading a turn that
  // changed no files gets, and the same word for it.
  if (commitSha === null) return { kind: "close", jobId, outcome: "unverified" };

  if (state.atCheckpoint) {
    // HEAD is a commit verification already agreed with. For a job still `verifying` that is
    // its own round, answered; for one still `working` the checkpoint predates it and its turn
    // moved nothing. Either way the project has been checked and re-running would re-run
    // verified work.
    return { kind: "close", jobId, outcome: job.phase === "verifying" ? "verified" : "unverified" };
  }

  return {
    kind: "verify",
    jobId,
    objective,
    commitSha,
    announce: job.phase === "working",
    attemptsUsed,
    attempts: job.checks.filter((check) => check.outcome === "failed").map(toAttempt),
  };
}

/**
 * The newest round's failure as an attempt already made.
 *
 * Only reached on a job that is verifying again, which means a repair turn has already answered
 * this failure — so it belongs in the prompt as something that was tried, not as the thing to
 * fix now.
 */
function toAttempt(check: { name: string; output: string | null }): FailedAttempt {
  return { check: check.name, detail: RECORDED_DETAIL, output: check.output };
}
