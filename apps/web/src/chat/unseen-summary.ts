/**
 * What the product tells you it decided while you were not watching.
 *
 * This is the sentence the name *Nap* is a promise about. A turn runs on a worker behind a queue
 * and the worker cannot see the socket (docs/adr/0009), so work genuinely continues after a
 * laptop closes — and coming back to a transcript that grew is not the same as being told what
 * came of it. The seam in `unseen.ts` says *where* your reading stopped. This says *what
 * happened* below it, once, in a sentence.
 *
 * **It fires on a conclusion, not on elapsed time or on volume.** The trigger is a
 * `job.completed`, a `job.checkpointed` or a `turn.failed` among the unseen events, and nothing
 * else. Away four hours but the job had already finished before you left: nothing — nothing was
 * decided in your absence. Away ninety seconds and it verified in that window: a card, because
 * that is exactly the moment this is supposed to pay off. A time threshold has an N that is
 * arbitrary and wrong for somebody, and a volume threshold produces "while you were away: 47
 * events", which is true and worthless. **Most returns produce nothing, and that is the design**
 * — this earns its interruption by being rare.
 *
 * **The copy is singular, because the system is.** An early mock of this claimed "3 checkpoints
 * created"; a job emits at most one `job.checkpointed` and `MAX_REPAIR_ATTEMPTS` is 3, so three
 * checkpoints needs three jobs, needs three prompts, needs somebody sitting there typing them.
 * The plural is unreachable by construction, and shipping it would be the interface claiming
 * more than the log supports.
 *
 * Pure, and the wording is here rather than in the component for the reason `job-summary.ts`
 * gives: these sentences are claims about whether somebody's work survived, and a claim is worth
 * a test. `unseen-card.tsx` is only what it looks like.
 */

import type { JobOutcome, NapEvent, NapEventOf } from "@nap/shared/events";
import { foldJobs, isJobFailed, type JobState, openJob } from "@nap/shared/job-state";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { turnFailureCopy } from "../errors/failure-copy.ts";
import { shortSha } from "./job-summary.ts";

/**
 * The three events that mean something was decided.
 *
 * `job.checkpointed` is in the list beside `job.completed`, which usually follows it a moment
 * later, so that a worker which died between the two still reports the strongest evidence in the
 * log: the commit that passed. Waiting for the tidier event would be silence about the one thing
 * that definitely happened.
 */
type Conclusion =
  | NapEventOf<"job.completed">
  | NapEventOf<"job.checkpointed">
  | NapEventOf<"turn.failed">;

function isConclusion(event: NapEvent): event is Conclusion {
  return (
    event.type === "job.completed" ||
    event.type === "job.checkpointed" ||
    event.type === "turn.failed"
  );
}

export type UnseenSummary = {
  /**
   * What was asked, or `null` when nothing in the log attributes the conclusion to a job — a
   * turn that failed before a job could open, or a window that begins after one did.
   */
  objective: string | null;
  /** How it ended, in one sentence. */
  outcome: string;
  /** Repairs spent, spelled out, and what they were spent on; `null` when none were. */
  repairs: string | null;
  /** The commit this job checkpointed, abbreviated — `null` if it reached none. */
  checkpoint: string | null;
  /** Ended with work left undone. What earns the card its mark, and its one alarm colour. */
  failed: boolean;
};

/**
 * How a job ended, said to somebody who was not here for it.
 *
 * A second vocabulary beside `PHASE_LABELS` on purpose, and the same split `working-state.ts`
 * makes between a word for reading down a column and a sentence for reading as prose: "Out of
 * repairs" is a status, and this is telling somebody what became of their app.
 *
 * Keyed on the four *outcomes* rather than on the seven phases, because nothing gets this far
 * without a conclusion in the log — an open job has decided nothing, which is the whole rule
 * above. A fifth outcome added in `@nap/shared` fails typecheck here rather than rendering an
 * empty sentence.
 */
const OUTCOMES: Record<JobOutcome, string> = {
  verified: "Your app is verified — the last commit passed its checks.",
  // Not a failure and not a success: a turn that answered a question changed no files, so there
  // was nothing to commit and nothing to check (see `JobOutcome`).
  unverified: "It finished without changing anything to check.",
  exhausted: "It ran out of repairs, and the checks are still failing.",
  abandoned: "It stopped before finishing.",
};

/**
 * What to say about work that concluded while nobody was looking, or `null` when there is
 * nothing to say.
 *
 * `seen` is the cursor from `useSeenCursor` — where this browser's reading stopped. Absent means
 * this browser has never opened the session, which is not the same as having seen none of it:
 * there is no place it left off, so there is no absence to describe.
 */
export function unseenSummary(
  events: readonly StoredEvent[],
  seen: number | undefined,
): UnseenSummary | null {
  if (seen === undefined) return null;

  // The newest, because a session can conclude twice while you are gone — a job closing and the
  // next one failing to start — and this is one sentence about where things now stand rather
  // than a digest of the interval.
  const conclusion = events.findLast(
    (event): event is Conclusion => event.seq > seen && isConclusion(event),
  );
  if (conclusion === undefined) return null;

  const job = attributedJob(events, conclusion);
  const repairedCheck = job === undefined ? null : failedCheck(events, job.jobId);

  if (conclusion.type === "turn.failed") {
    const { reason, message } = conclusion.payload;
    return {
      objective: job?.objective ?? null,
      // The one place failures are worded in this app, so a turn that failed while you were away
      // reads the same as one that failed in front of you.
      outcome: turnFailureCopy(reason, message).title,
      repairs: repairsSentence(job?.attemptsUsed ?? 0, true, repairedCheck),
      checkpoint: shortSha(job?.checkpointSha ?? null),
      failed: true,
    };
  }

  // Taken from the event rather than from the fold, so a conclusion whose job is outside the
  // folded window still says how it ended. Only the objective is genuinely unknowable there, and
  // it is left unsaid rather than guessed at from a neighbouring job.
  const outcome: JobOutcome =
    conclusion.type === "job.completed"
      ? conclusion.payload.outcome
      : // A checkpoint is a commit verification agreed with, which is what `verified` means. The
        // `job.completed` saying so is usually the next event; a card that waited for it would
        // be silent about a worker that died in between.
        "verified";
  const failed = isJobFailed({ phase: outcome });

  return {
    objective: job?.objective ?? null,
    outcome: OUTCOMES[outcome],
    repairs: repairsSentence(job?.attemptsUsed ?? 0, failed, repairedCheck),
    checkpoint: shortSha(job?.checkpointSha ?? null),
    failed,
  };
}

/**
 * The job the conclusion belongs to, if the log says which.
 *
 * `turn.failed` carries no `jobId`, so it is attributed by position — and only to a job that is
 * still *open*. A failure arriving after the last job closed is the next prompt's, whose job
 * never opened (the runtime opens one only once it has a sandbox in hand), and reading the
 * previous job's objective there would put somebody else's sentence under a failure that had
 * nothing to do with it.
 */
function attributedJob(
  events: readonly StoredEvent[],
  conclusion: Conclusion,
): JobState | undefined {
  const state = foldJobs(events);
  if (conclusion.type === "turn.failed") return openJob(state);

  return state.jobs.find((job) => job.jobId === conclusion.payload.jobId);
}

/**
 * What the repairs were spent on: the check that last said no.
 *
 * Read from the log rather than from the fold, because the fold deliberately keeps only the
 * *newest* verification's findings — and a job that repaired successfully ends with everything
 * green, so the thing that was wrong is only in the round before. That round is exactly what
 * makes the sentence specific instead of "one repair was needed" over an unnamed failure.
 *
 * The first failure of the last failing round, since a run short-circuits: the check after a
 * failure is `absent`, so the first red one is the one that actually stopped it.
 */
function failedCheck(events: readonly StoredEvent[], jobId: string): string | null {
  const round = events.findLast(
    (event): event is NapEventOf<"verification.completed"> =>
      event.type === "verification.completed" &&
      event.payload.jobId === jobId &&
      event.payload.checks.some((check) => check.outcome === "failed"),
  );

  return round?.payload.checks.find((check) => check.outcome === "failed")?.name ?? null;
}

/**
 * Repairs spent, in words, and what on.
 *
 * Words rather than digits, and no total beside them: this is prose somebody reads once, where
 * "1 of 3 repairs used" is a gauge on a strip they are watching. Spelling them out is only
 * possible because `MAX_REPAIR_ATTEMPTS` bounds them at three — so raising that constant falls
 * back to a digit rather than silently saying nothing, which is what an array lookup alone would
 * have done.
 *
 * **Spent, not needed, when the job failed.** "Three repairs were needed" reads as three repairs
 * that worked; a job that ran out of them fixed nothing.
 */
function repairsSentence(
  attemptsUsed: number,
  failed: boolean,
  check: string | null,
): string | null {
  if (attemptsUsed <= 0) return null;

  const words = ["", "One", "Two", "Three"];
  const count = attemptsUsed < words.length ? words[attemptsUsed] : String(attemptsUsed);
  const subject = `${count} ${attemptsUsed === 1 ? "repair was" : "repairs were"}`;

  // Named where the log names it. The alternative — "one repair was needed", full stop — is a
  // sentence about an event rather than about the reader's project, and the check's name is the
  // one word in it that says what was actually wrong.
  if (check === null) return `${subject} ${failed ? "spent" : "needed"}.`;

  return failed
    ? `${subject} spent — ${check} is still failing.`
    : `${subject} needed — ${check} failed, and was fixed.`;
}
