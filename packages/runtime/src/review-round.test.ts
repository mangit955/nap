import type { NapEvent } from "@nap/shared/events";
import type { ReviewResult } from "@nap/shared/ports/reviewer";
import { describe, expect, it } from "vitest";
import { changedFilesOf, renderFinding, reviewCheck, reviewRounds } from "./review-round.ts";

const result = (overrides: Partial<ReviewResult>): ReviewResult => ({
  status: "completed",
  blocking: [],
  notes: [],
  failure: null,
  steps: 1,
  usage: { inputTokens: 1, outputTokens: 1 },
  ...overrides,
});
const proved = { summary: "parse returns 2", command: "pytest -q", observed: "expected 3\ngot 2" };

describe("reviewCheck", () => {
  it("passes with no notes as a check with no output", () => {
    expect(reviewCheck(result({}))).toEqual({
      check: { name: "review", outcome: "passed", output: null },
      failure: null,
    });
  });

  it("passes with its notes, and says when it did not finish, but blocks nothing", () => {
    const { check, failure } = reviewCheck(
      result({
        status: "failed",
        failure: "Ran out of steps before reporting.",
        notes: [{ summary: "unproved", command: "ls", observed: "x" }],
      }),
    );
    expect(failure).toBeNull();
    expect(check.outcome).toBe("passed");
    expect(check.output).toContain("did not finish cleanly: Ran out of steps");
    expect(check.output).toContain("- unproved");
  });

  it("fails with what it proved, as the failure a repair is prompted from", () => {
    const { check, failure } = reviewCheck(result({ blocking: [proved] }));
    expect(check.outcome).toBe("failed");
    expect(failure).toEqual({
      name: "review",
      detail: "1 problem shown by commands the reviewer ran",
      output: renderFinding(proved),
    });
  });
});

describe("renderFinding", () => {
  it("quotes the command and indents what it printed", () => {
    expect(renderFinding(proved)).toBe(
      "- parse returns 2\n  `pytest -q` printed:\n    expected 3\n    got 2",
    );
    expect(renderFinding({ summary: "a note", command: null, observed: null })).toBe("- a note");
  });
});

describe("changedFilesOf", () => {
  const envelope = { sessionId: "s", turnId: "t", createdAt: "2026-01-01T00:00:00.000Z" };
  const changed = (seq: number, path: string) =>
    ({
      ...envelope,
      seq,
      type: "file.changed",
      payload: { path, changeType: "modified", diff: "" },
    }) as NapEvent;
  const jobStarted = (seq: number, jobId: string) =>
    ({ ...envelope, seq, type: "job.started", payload: { jobId, objective: "x" } }) as NapEvent;

  it("lists each file once, oldest first", () => {
    expect(changedFilesOf([changed(1, "b"), changed(2, "a"), changed(3, "b")])).toEqual(["b", "a"]);
  });

  it("with a job, lists only what changed since that job opened", () => {
    const events = [changed(1, "old"), jobStarted(2, "j"), changed(3, "new")];
    expect(changedFilesOf(events, "j")).toEqual(["new"]);
  });
});

describe("reviewRounds", () => {
  const envelope = { sessionId: "s", turnId: "t", createdAt: "2026-01-01T00:00:00.000Z" };
  const verified = (seq: number, jobId: string, names: string[]) =>
    ({
      ...envelope,
      seq,
      type: "verification.completed",
      payload: {
        jobId,
        checks: names.map((name) => ({ name, outcome: "failed", output: null })),
      },
    }) as NapEvent;

  it("counts the job's verifications that carried a review, from the log alone", () => {
    // Read from the log rather than from what the running job remembers, which a restart rebuilds
    // from the latest round only: the bound has to survive a restart.
    const history = [
      verified(1, "j", ["typecheck"]),
      verified(2, "j", ["test", "review"]),
      verified(3, "other", ["review"]),
      verified(4, "j", ["review"]),
    ];
    expect(reviewRounds(history, "j")).toBe(2);
  });
});
