/**
 * What opening a project should do about the job it finds still open.
 *
 * Pure, so every case here is a literal log folded by `foldJobs` — no runtime, no sandbox, no
 * model. That is the point of splitting the decision out of `SingleAgentRuntime`: whether
 * opening a project spends tokens is the expensive question in this area, and it should be
 * answerable by reading a table of inputs rather than by tracing an orchestrator.
 */

import type { JobOutcome, NapEvent, VerifiedCheck } from "@nap/shared/events";
import { foldJobs, MAX_REPAIR_ATTEMPTS } from "@nap/shared/job-state";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { describe, expect, it } from "vitest";
import { continuationFor } from "./continue-job.ts";

const SESSION = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";
const JOB_A = "3f9a1c2d-5e6b-4f7a-8b9c-0d1e2f3a4b5c";
const JOB_B = "8c7b6a59-4d3e-4f21-9a8b-7c6d5e4f3a2b";
const SHA = "9e107d9d372bb6826bd81d3542a419d6c2b0f5a1";
const LATER_SHA = "1f3e5d7c9b8a6f4e2d0c1b3a5978d6c4e2b0a1f3";

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

const started = (jobId: string, objective = "add a delete button") => ({
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
const SILENT: VerifiedCheck = { name: "build", outcome: "failed", output: null };
const UNASKED: VerifiedCheck = { name: "test", outcome: "absent", output: null };

const decide = (...events: readonly { type: NapEvent["type"]; payload: unknown }[]) =>
  continuationFor(foldJobs(log(...events)));

/** One round of checks that said no. */
const redRound = (jobId: string) => [verifying(jobId), verified(jobId, FAILED)];

describe("a session with nothing open", () => {
  it("continues nothing when it has no jobs at all", () => {
    expect(decide(committed(SHA))).toEqual({ kind: "none" });
  });

  it("continues nothing when its last job closed", () => {
    const decision = decide(
      started(JOB_A),
      committed(SHA),
      verifying(JOB_A),
      verified(JOB_A, PASSED),
      checkpoint(JOB_A, SHA),
      closed(JOB_A, "verified"),
    );
    expect(decision).toEqual({ kind: "none" });
  });

  it("continues nothing when a green round closed the job without a job.completed", () => {
    // The fold already reads this as `verified` — the answer the job existed to get is in the
    // log, so a crash that swallowed the closing event cost nothing.
    const decision = decide(
      started(JOB_A),
      committed(SHA),
      verifying(JOB_A),
      verified(JOB_A, PASSED),
    );
    expect(decision).toEqual({ kind: "none" });
  });

  it("continues nothing when an older job was left open under a newer one", () => {
    // Only the newest job can be continued: a later one has already been opened over it.
    const decision = decide(started(JOB_A), started(JOB_B), closed(JOB_B, "verified"));
    expect(decision).toEqual({ kind: "none" });
  });
});

describe("a job whose turn never got as far as committing", () => {
  it("closes it unverified rather than running checks against nothing", () => {
    expect(decide(started(JOB_A))).toEqual({
      kind: "close",
      jobId: JOB_A,
      outcome: "unverified",
    });
  });

  it("closes it unverified rather than verifying an earlier job's commit again", () => {
    // `headSha` is the session's rather than the job's. HEAD is already a checkpoint, so this
    // job cannot have moved it — and re-running the checks would be re-running verified work.
    const decision = decide(
      started(JOB_A),
      committed(SHA),
      verifying(JOB_A),
      verified(JOB_A, PASSED),
      checkpoint(JOB_A, SHA),
      closed(JOB_A, "verified"),
      started(JOB_B),
    );
    expect(decision).toEqual({ kind: "close", jobId: JOB_B, outcome: "unverified" });
  });
});

describe("a job interrupted with work committed and unverified", () => {
  it("runs the checks, announcing a round the log does not have", () => {
    const decision = decide(started(JOB_A), committed(SHA));
    expect(decision).toEqual({
      kind: "verify",
      jobId: JOB_A,
      objective: "add a delete button",
      commitSha: SHA,
      announce: true,
      attemptsUsed: 0,
      attempts: [],
    });
  });

  it("runs the checks without announcing when a round was already begun", () => {
    // `verification.started` is in the log and its answer is not. Emitting a second one would
    // spend a repair attempt on a round the log has already counted.
    const decision = decide(started(JOB_A), committed(SHA), verifying(JOB_A));
    expect(decision).toMatchObject({ kind: "verify", commitSha: SHA, announce: false });
  });

  it("keeps the attempts already spent when it re-runs an interrupted round", () => {
    const decision = decide(
      started(JOB_A),
      committed(SHA),
      ...redRound(JOB_A),
      committed(LATER_SHA),
      verifying(JOB_A),
    );
    expect(decision).toMatchObject({
      kind: "verify",
      commitSha: LATER_SHA,
      announce: false,
      attemptsUsed: 1,
    });
  });

  it("carries the failure that prompted the interrupted round into the next prompt", () => {
    const decision = decide(
      started(JOB_A),
      committed(SHA),
      ...redRound(JOB_A),
      committed(LATER_SHA),
      verifying(JOB_A),
    );
    expect(decision).toMatchObject({
      kind: "verify",
      attempts: [{ check: "typecheck", output: "1 error" }],
    });
  });
});

describe("a job left in repair", () => {
  it("repairs from the failure the log recorded, without re-running the checks", () => {
    const decision = decide(
      started(JOB_A),
      committed(SHA),
      verifying(JOB_A),
      verified(JOB_A, FAILED, UNASKED),
    );
    expect(decision).toMatchObject({
      kind: "repair",
      jobId: JOB_A,
      objective: "add a delete button",
      attemptsUsed: 0,
      failed: { name: "typecheck", output: "1 error" },
    });
  });

  it("says where the failure came from, since the run that found it is over", () => {
    const decision = decide(started(JOB_A), committed(SHA), ...redRound(JOB_A));
    if (decision.kind !== "repair") throw new Error(`expected a repair, got ${decision.kind}`);
    expect(decision.failed.detail).not.toBe("");
  });

  it("carries a silent failure through as no output rather than as an empty quote", () => {
    const decision = decide(
      started(JOB_A),
      committed(SHA),
      verifying(JOB_A),
      verified(JOB_A, SILENT),
    );
    expect(decision).toMatchObject({ kind: "repair", failed: { name: "build", output: null } });
  });

  it("resumes the budget where it stopped rather than at the beginning", () => {
    const decision = decide(
      started(JOB_A),
      committed(SHA),
      ...redRound(JOB_A),
      committed(LATER_SHA),
      ...redRound(JOB_A),
    );
    expect(decision).toMatchObject({ kind: "repair", attemptsUsed: 1 });
  });

  it("has nothing to continue once the attempts are spent", () => {
    const rounds = Array.from({ length: MAX_REPAIR_ATTEMPTS + 1 }, () => redRound(JOB_A)).flat();
    // The fold already calls this `exhausted`, which is closed, so nothing is left to do.
    expect(decide(started(JOB_A), committed(SHA), ...rounds)).toEqual({ kind: "none" });
  });
});
