/**
 * What the session's events say about its jobs.
 *
 * A job has no table and no file behind it. It is a fold over the log, exactly as a turn is,
 * which is what makes "resuming is replaying" true rather than aspirational: there is one
 * source of truth and no second copy of it to drift. See `CONTEXT.md` and docs/adr/0006.
 *
 * Pure, and deliberately so — it takes an ordered array and returns a value, so the runtime,
 * the API and the browser can each fold the same log and agree, and its tests are literal
 * arrays with no store, no clock and no container behind them.
 *
 * **A partial log is the normal input, not the exceptional one.** A process that died mid-turn
 * leaves a job open with no terminal event; a client that reconnected reads from a `seq` in the
 * middle of one. Neither throws here. What cannot be recovered is stated as such rather than
 * invented: a job whose opening is outside the window is not folded at all, because its
 * objective is unknowable and a repair prompted from a guessed objective is worse than none.
 *
 * Events are assumed to arrive in `seq` order, which is what `EventStore.readFrom` and the
 * session log both guarantee. Nothing re-sorts them.
 */

import type { JobOutcome, NapEvent, VerifiedCheck } from "./events.ts";
import type { StoredEvent } from "./ports/event-store.ts";

/**
 * Repair turns permitted per job.
 *
 * A cap on attempts rather than a cumulative token ledger: the ledger is a second accounting
 * system to build and test, where this bounds the worst case at three extra turns, which is
 * the property actually wanted (docs/adr/0006).
 */
export const MAX_REPAIR_ATTEMPTS = 3;

/**
 * What a job is doing, or what it ended as.
 *
 * The three open phases, then the four ways a job closes — a closed job's phase *is* its
 * outcome, so there is no second vocabulary for the same fact.
 */
export type JobPhase = "working" | "verifying" | "repairing" | JobOutcome;

const OPEN_PHASES = new Set<JobPhase>(["working", "verifying", "repairing"]);

export type JobState = {
  jobId: string;
  /** What was asked, as the prompt that opened the job put it. */
  objective: string;
  phase: JobPhase;
  /** The most recent verification's findings; empty until one has completed. */
  checks: readonly VerifiedCheck[];
  /** Repair turns already run. */
  attemptsUsed: number;
  /** Repair turns still permitted. Zero of these plus red checks is what `exhausted` means. */
  attemptsRemaining: number;
};

export type SessionJobs = {
  /** In the order they opened. Jobs are serial — a session runs one turn at a time. */
  jobs: readonly JobState[];
  /** The newest commit any completed turn produced, or `null` if none has. */
  headSha: string | null;
  /** The newest commit verification agreed with — the last known-good state. */
  checkpointSha: string | null;
  /**
   * `HEAD == last checkpoint`: whether the project is in a state something has checked.
   *
   * True when neither exists, because a session that has committed nothing has nothing
   * unverified in it — the alternative reports a project nobody has touched as needing repair.
   */
  atCheckpoint: boolean;
};

export function isJobOpen(job: JobState): boolean {
  return OPEN_PHASES.has(job.phase);
}

/**
 * The job still being worked on, if there is one.
 *
 * Only the newest can be open, because a session runs one turn at a time and a job is a run of
 * turns. An earlier job left open by a truncated log is history either way — nothing will
 * continue a job that a later one has already been opened over.
 */
export function openJob(state: SessionJobs): JobState | undefined {
  const newest = state.jobs.at(-1);
  return newest !== undefined && isJobOpen(newest) ? newest : undefined;
}

/** What the fold accumulates per job, before a phase is decided from it. */
type Tally = {
  jobId: string;
  objective: string;
  checks: readonly VerifiedCheck[];
  /**
   * Verifications begun and verifications answered, counted apart.
   *
   * Repair attempts are derived from the first of these, and that is the load-bearing part.
   * Every verification after the first was preceded by a repair turn, so `started - 1` is the
   * number of repairs run — a fact the loop's shape guarantees, needing no marker on the turn.
   * Counted from `completed` instead, a job interrupted while its second verification ran would
   * come back believing it still had an attempt it has already spent.
   *
   * The gap between the two is also the only evidence that checks are running right now.
   */
  started: number;
  completed: number;
  /** Whether the most recent answered verification found a failure. */
  red: boolean;
  outcome: JobOutcome | undefined;
};

type JobEvent = Extract<NapEvent, { payload: { jobId: string } }>;

function isJobEvent(event: NapEvent): event is JobEvent {
  return event.type.startsWith("job.") || event.type.startsWith("verification.");
}

export function foldJobs(events: readonly StoredEvent[]): SessionJobs {
  const tallies: Tally[] = [];
  const byId = new Map<string, Tally>();
  let headSha: string | null = null;
  let checkpointSha: string | null = null;

  for (const event of events) {
    // A turn that changed nothing committed nothing, and leaves HEAD where it was.
    if (event.type === "turn.completed") {
      if (event.payload.commitSha !== null) headSha = event.payload.commitSha;
      continue;
    }

    // Taken whether or not the job it belongs to is in this window, and whether or not that job
    // has since closed: the sha is a fact about the project rather than about the job, and it
    // is the one half of "is this project in a valid state".
    if (event.type === "job.checkpointed") {
      checkpointSha = event.payload.commitSha;
      // A checkpoint is a commit that verification agreed with, so it is also evidence that a
      // commit happened — evidence a window opening between the `turn.completed` that made it
      // and this event would otherwise lack. Without this, a verified project read from that
      // window reports HEAD as having diverged from a checkpoint it is sitting on. Only ever
      // fills a gap: a later commit still moves HEAD off it.
      headSha ??= event.payload.commitSha;
      continue;
    }

    if (!isJobEvent(event)) continue;

    if (event.type === "job.started") {
      const tally: Tally = {
        jobId: event.payload.jobId,
        objective: event.payload.objective,
        checks: [],
        started: 0,
        completed: 0,
        red: false,
        outcome: undefined,
      };
      tallies.push(tally);
      byId.set(tally.jobId, tally);
      continue;
    }

    const tally = byId.get(event.payload.jobId);
    // An orphan — the job's opening is outside the window — or an event after the job closed.
    // The second is not a contradiction to resolve: whatever closed the job said so first.
    if (tally === undefined || tally.outcome !== undefined) continue;

    switch (event.type) {
      case "verification.started":
        tally.started++;
        break;
      case "verification.completed":
        tally.completed++;
        // A verification that answered was begun, whether or not its start is in the window.
        tally.started = Math.max(tally.started, tally.completed);
        // Only the newest findings are kept. The older rounds are still in the log for anyone
        // assembling a history of what has been tried; this is the current answer.
        tally.checks = event.payload.checks;
        tally.red = event.payload.checks.some((check) => check.outcome === "failed");
        break;
      case "job.completed":
        tally.outcome = event.payload.outcome;
        break;
    }
  }

  return {
    jobs: tallies.map(toJobState),
    headSha,
    checkpointSha,
    atCheckpoint: headSha === checkpointSha,
  };
}

function toJobState(tally: Tally): JobState {
  const attemptsUsed = Math.min(Math.max(tally.started - 1, 0), MAX_REPAIR_ATTEMPTS);
  return {
    jobId: tally.jobId,
    objective: tally.objective,
    phase: phaseOf(tally, attemptsUsed),
    checks: tally.checks,
    attemptsUsed,
    attemptsRemaining: MAX_REPAIR_ATTEMPTS - attemptsUsed,
  };
}

/**
 * What a job's events add up to.
 *
 * `job.completed` wins wherever it exists: it is the runtime saying how the job ended, and the
 * rest of this function is only for the log that stops before it was written. What that
 * derivation may and may not conclude is the careful part.
 *
 * It may conclude a job is **open**, freely — that is the safe direction, since continuing a
 * job that had nothing left to do costs one fold and no tokens.
 *
 * It may conclude a job is **closed** in exactly two cases, and both are ones where the log
 * already contains the answer the job existed to get: a verification that came back green, and
 * a verification that came back red with no attempts left to spend on it. Neither can be turned
 * into more work by continuing it, so calling them closed guesses nothing — the job.completed
 * that a crash swallowed would have said the same thing. Anything short of those two stays open.
 */
function phaseOf(tally: Tally, attemptsUsed: number): JobPhase {
  if (tally.outcome !== undefined) return tally.outcome;
  // Begun and unanswered. Ahead of the checks below so that a round in flight is not reported
  // as the previous round's verdict, which is a stale answer wearing a current one's clothes.
  if (tally.started > tally.completed) return "verifying";
  if (tally.completed === 0) return "working";
  // Nothing red. Checks that were *absent* land here too, and deliberately: a project with no
  // test script has not failed its tests (docs/adr/0002), and calling that unfinished would put
  // every project without a full complement of scripts into a repair loop it cannot leave. What
  // was and was not actually run is on `checks` for anything that wants to say so out loud.
  if (!tally.red) return "verified";
  return attemptsUsed < MAX_REPAIR_ATTEMPTS ? "repairing" : "exhausted";
}
