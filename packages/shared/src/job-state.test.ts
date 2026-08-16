import { describe, expect, it } from "vitest";
import type { JobOutcome, NapEvent, VerifiedCheck } from "./events.ts";
import { foldJobs, isJobOpen, MAX_REPAIR_ATTEMPTS, openJob } from "./job-state.ts";
import type { StoredEvent } from "./ports/event-store.ts";

const SESSION = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";
const JOB_A = "3f9a1c2d-5e6b-4f7a-8b9c-0d1e2f3a4b5c";
const JOB_B = "8c7b6a59-4d3e-4f21-9a8b-7c6d5e4f3a2b";

/**
 * Builds a log out of payloads, assigning `seq` by position.
 *
 * The fold reads an ordered log and nothing else, so a test is a literal array — no store, no
 * container, no clock. `turnId` is one per event because nothing here reads it: a job is a run
 * of events, not a set of turns.
 */
function log(...events: readonly { type: NapEvent["type"]; payload: unknown }[]): StoredEvent[] {
  return events.map(
    (event, index) =>
      ({
        ...event,
        sessionId: SESSION,
        turnId: "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f",
        seq: index,
        createdAt: "2026-08-16T12:00:00.000Z",
      }) as StoredEvent,
  );
}

const started = (jobId: string, objective = "build me a todo list") => ({
  type: "job.started" as const,
  payload: { jobId, objective },
});
const verifying = (jobId: string) => ({
  type: "verification.started" as const,
  payload: { jobId },
});
const verified = (jobId: string, ...checks: VerifiedCheck[]) => ({
  type: "verification.completed" as const,
  payload: { jobId, checks },
});
const checkpoint = (jobId: string, commitSha: string) => ({
  type: "job.checkpointed" as const,
  payload: { jobId, commitSha },
});
const closed = (jobId: string, outcome: JobOutcome) => ({
  type: "job.completed" as const,
  payload: { jobId, outcome },
});
const committed = (commitSha: string | null) => ({
  type: "turn.completed" as const,
  payload: { usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1, commitSha },
});

const PASSED: VerifiedCheck = { name: "typecheck", outcome: "passed", output: null };
const FAILED: VerifiedCheck = { name: "typecheck", outcome: "failed", output: "1 error" };
const ABSENT: VerifiedCheck = { name: "test", outcome: "absent", output: null };

/** One job's worth of a failed round: checks run, they were red. */
const failedRound = (jobId: string) => [verifying(jobId), verified(jobId, FAILED)];

describe("foldJobs", () => {
  it("finds no jobs in a log that has none", () => {
    const state = foldJobs(log(committed("abc123")));
    expect(state.jobs).toEqual([]);
    expect(openJob(state)).toBeUndefined();
  });

  it("opens a job on job.started, carrying what was asked", () => {
    const state = foldJobs(log(started(JOB_A, "add a dark mode toggle")));
    expect(state.jobs).toHaveLength(1);
    expect(state.jobs[0]?.jobId).toBe(JOB_A);
    expect(state.jobs[0]?.objective).toBe("add a dark mode toggle");
    expect(state.jobs[0]?.phase).toBe("working");
    expect(state.jobs[0]?.checks).toEqual([]);
    expect(openJob(state)?.jobId).toBe(JOB_A);
  });

  it("reports a verification in flight as its own phase", () => {
    const state = foldJobs(log(started(JOB_A), verifying(JOB_A)));
    expect(state.jobs[0]?.phase).toBe("verifying");
    expect(isJobOpen(state.jobs[0]!)).toBe(true);
  });

  it("keeps the checks of the most recent verification only", () => {
    const state = foldJobs(
      log(started(JOB_A), ...failedRound(JOB_A), verifying(JOB_A), verified(JOB_A, PASSED, ABSENT)),
    );
    expect(state.jobs[0]?.checks).toEqual([PASSED, ABSENT]);
  });

  it("closes a job the log says is closed", () => {
    const state = foldJobs(
      log(
        started(JOB_A),
        committed("abc123"),
        verifying(JOB_A),
        verified(JOB_A, PASSED),
        checkpoint(JOB_A, "abc123"),
        closed(JOB_A, "verified"),
      ),
    );
    expect(state.jobs[0]?.phase).toBe("verified");
    expect(isJobOpen(state.jobs[0]!)).toBe(false);
    expect(openJob(state)).toBeUndefined();
  });

  it("counts a verification that found nothing to run as passing", () => {
    // The all-absent case, decided rather than fallen into. A project with no scripts has not
    // failed anything (docs/adr/0002), and the opposite answer would leave every such project
    // in a repair loop no repair can close. `checks` is right there for a reader that wants to
    // say "nothing was checked" out loud rather than "verified".
    const state = foldJobs(log(started(JOB_A), verifying(JOB_A), verified(JOB_A, ABSENT)));
    expect(state.jobs[0]?.phase).toBe("verified");
    expect(state.jobs[0]?.checks).toEqual([ABSENT]);
  });

  it("prefers what the log says a job closed as over what the checks imply", () => {
    // Cancelled mid-repair: the checks were red, and the job still ended honestly rather than
    // as a job still waiting for a repair that nobody is going to run.
    const state = foldJobs(log(started(JOB_A), ...failedRound(JOB_A), closed(JOB_A, "abandoned")));
    expect(state.jobs[0]?.phase).toBe("abandoned");
  });

  it("ignores everything about a job after it closed", () => {
    const state = foldJobs(
      log(started(JOB_A), closed(JOB_A, "unverified"), verifying(JOB_A), closed(JOB_A, "verified")),
    );
    expect(state.jobs[0]?.phase).toBe("unverified");
  });

  it("folds several jobs in the order they opened", () => {
    const state = foldJobs(
      log(started(JOB_A, "first"), closed(JOB_A, "unverified"), started(JOB_B, "second")),
    );
    expect(state.jobs.map((job) => job.objective)).toEqual(["first", "second"]);
    expect(openJob(state)?.jobId).toBe(JOB_B);
  });
});

describe("foldJobs attempts", () => {
  it("spends nothing before the first verification fails", () => {
    const state = foldJobs(log(started(JOB_A), ...failedRound(JOB_A)));
    expect(state.jobs[0]?.phase).toBe("repairing");
    expect(state.jobs[0]?.attemptsUsed).toBe(0);
    expect(state.jobs[0]?.attemptsRemaining).toBe(MAX_REPAIR_ATTEMPTS);
  });

  it("counts a repair from the verification that follows it, not from a marker", () => {
    const state = foldJobs(log(started(JOB_A), ...failedRound(JOB_A), ...failedRound(JOB_A)));
    expect(state.jobs[0]?.attemptsUsed).toBe(1);
    expect(state.jobs[0]?.attemptsRemaining).toBe(2);
  });

  it("counts a repair whose verification has started but not finished", () => {
    // Otherwise the strip reads "1 of 3" while the second repair is being checked, and a
    // process that died here would resume believing it had an attempt it has already spent.
    const state = foldJobs(log(started(JOB_A), ...failedRound(JOB_A), verifying(JOB_A)));
    expect(state.jobs[0]?.attemptsUsed).toBe(1);
    expect(state.jobs[0]?.phase).toBe("verifying");
  });

  it("exhausts after three repairs, and not before", () => {
    const rounds = (n: number) =>
      foldJobs(log(started(JOB_A), ...Array.from({ length: n }, () => failedRound(JOB_A)).flat()));

    // The third failure still buys a repair: three repairs means four verifications.
    expect(rounds(MAX_REPAIR_ATTEMPTS).jobs[0]?.phase).toBe("repairing");
    expect(rounds(MAX_REPAIR_ATTEMPTS).jobs[0]?.attemptsRemaining).toBe(1);

    const spent = rounds(MAX_REPAIR_ATTEMPTS + 1).jobs[0];
    expect(spent?.phase).toBe("exhausted");
    expect(spent?.attemptsUsed).toBe(MAX_REPAIR_ATTEMPTS);
    expect(spent?.attemptsRemaining).toBe(0);
    expect(isJobOpen(spent!)).toBe(false);
  });

  it("never reports more attempts spent than the bound allows", () => {
    const state = foldJobs(
      log(started(JOB_A), ...Array.from({ length: 9 }, () => failedRound(JOB_A)).flat()),
    );
    expect(state.jobs[0]?.attemptsUsed).toBe(MAX_REPAIR_ATTEMPTS);
    expect(state.jobs[0]?.attemptsRemaining).toBe(0);
  });
});

describe("foldJobs checkpoints", () => {
  it("calls a session with no commits at all checkpointed", () => {
    // Nothing has been written, so nothing is unverified. The alternative would show a project
    // that has never been touched as being in a state somebody needs to repair.
    const state = foldJobs(log(started(JOB_A), committed(null)));
    expect(state.headSha).toBeNull();
    expect(state.checkpointSha).toBeNull();
    expect(state.atCheckpoint).toBe(true);
  });

  it("is not at a checkpoint once a turn has committed something unverified", () => {
    const state = foldJobs(log(started(JOB_A), committed("abc123")));
    expect(state.headSha).toBe("abc123");
    expect(state.checkpointSha).toBeNull();
    expect(state.atCheckpoint).toBe(false);
  });

  it("is at a checkpoint when the newest commit is the one verification agreed with", () => {
    const state = foldJobs(
      log(
        started(JOB_A),
        committed("abc123"),
        verified(JOB_A, PASSED),
        checkpoint(JOB_A, "abc123"),
      ),
    );
    expect(state.atCheckpoint).toBe(true);
  });

  it("leaves the checkpoint behind when a later turn commits over it", () => {
    // The whole point of separating commit from checkpoint: a failing turn cannot corrupt the
    // last known-good sha, it can only be somewhere other than it.
    const state = foldJobs(
      log(
        started(JOB_A),
        committed("abc123"),
        checkpoint(JOB_A, "abc123"),
        closed(JOB_A, "verified"),
        started(JOB_B),
        committed("def456"),
      ),
    );
    expect(state.headSha).toBe("def456");
    expect(state.checkpointSha).toBe("abc123");
    expect(state.atCheckpoint).toBe(false);
  });

  it("does not move HEAD for a turn that committed nothing", () => {
    const state = foldJobs(log(started(JOB_A), committed("abc123"), committed(null)));
    expect(state.headSha).toBe("abc123");
  });
});

describe("foldJobs on a partial log", () => {
  it("leaves a job that was interrupted mid-turn open", () => {
    // A process that died mid-turn is the normal case. The job is not failed and not gone; it
    // is a job that will be continued when the project is next opened.
    const state = foldJobs(log(started(JOB_A), committed("abc123")));
    expect(state.jobs[0]?.phase).toBe("working");
    expect(openJob(state)?.jobId).toBe(JOB_A);
  });

  it("leaves a job interrupted mid-verification open, at the checks it had", () => {
    const state = foldJobs(log(started(JOB_A), ...failedRound(JOB_A), verifying(JOB_A)));
    expect(state.jobs[0]?.phase).toBe("verifying");
    expect(state.jobs[0]?.checks).toEqual([FAILED]);
  });

  it("ignores events for a job whose opening is not in the window", () => {
    // A log read from a `seq` in the middle of a job cannot say what was asked, and a job with
    // an invented objective is worse than no job: a repair would be prompted against a lie.
    const state = foldJobs(
      log(verifying(JOB_A), verified(JOB_A, FAILED), closed(JOB_A, "verified")),
    );
    expect(state.jobs).toEqual([]);
  });

  it("does not report a diverged HEAD from a window that opens on the checkpoint", () => {
    // A window beginning between the commit and the checkpoint that blessed it. The commit is
    // outside it, so nothing else says HEAD exists — and answering "no" would tell someone
    // sitting on a verified project that it needs repairing.
    const state = foldJobs(log(checkpoint(JOB_A, "abc123")));
    expect(state.headSha).toBe("abc123");
    expect(state.atCheckpoint).toBe(true);
  });

  it("still moves HEAD off a checkpoint when a later turn commits", () => {
    const state = foldJobs(log(checkpoint(JOB_A, "abc123"), committed("def456")));
    expect(state.headSha).toBe("def456");
    expect(state.atCheckpoint).toBe(false);
  });

  it("still reports the checkpoint from a window that opens mid-job", () => {
    // The sha is a fact about the project, not about the job, so a truncated head does not
    // cost the answer to "is this project in a valid state".
    const state = foldJobs(log(committed("abc123"), checkpoint(JOB_A, "abc123")));
    expect(state.atCheckpoint).toBe(true);
  });
});
