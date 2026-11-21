import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { FAKE_COMMIT_SHA, scriptGit } from "@nap/sandbox/testing/script-git";
import type { NapEvent } from "@nap/shared/events";
import { MAX_REVIEW_ROUNDS, type ReviewResult } from "@nap/shared/ports/reviewer";
import { describe, expect, it } from "vitest";
import {
  changedFilesOf,
  renderFinding,
  reviewCheck,
  reviewJob,
  reviewRounds,
} from "./review-round.ts";

const result_ = (overrides: Partial<ReviewResult>): ReviewResult => ({
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
    expect(reviewCheck(result_({}))).toEqual({
      check: { name: "review", outcome: "passed", output: null },
      failure: null,
    });
  });

  it("passes with its notes, and says when it did not finish, but blocks nothing", () => {
    const { check, failure } = reviewCheck(
      result_({
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
    const { check, failure } = reviewCheck(result_({ blocking: [proved] }));
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

describe("reviewJob", () => {
  it("runs no review once the log shows the job's last allowed one, whatever the caller thought", async () => {
    // A backstop behind the runtime's repairs-left gate, which already keeps a job to two reviews
    // today: this bound holds if that gate or the repair bound ever changes.
    const envelope = { sessionId: "s", turnId: "t", createdAt: "2026-01-01T00:00:00.000Z" };
    const reviewed = (seq: number) =>
      ({
        ...envelope,
        seq,
        type: "verification.completed",
        payload: { jobId: "j", checks: [{ name: "review", outcome: "failed", output: null }] },
      }) as NapEvent;
    let calls = 0;
    const sandbox = scriptGit(new InMemorySandboxManager());
    const created = await sandbox.create("p");
    if (!created.ok) throw new Error(created.error.message);
    const review = (history: NapEvent[]) =>
      reviewJob({
        reviewer: {
          review: async () => {
            calls += 1;
            return result_({});
          },
        },
        sandbox,
        sandboxId: created.value.id,
        commitSha: FAKE_COMMIT_SHA,
        jobId: "j",
        history,
        objective: "x",
        model: undefined,
        effort: undefined,
        credentials: undefined,
        signal: undefined,
      });
    // One short of the bound, the review runs: the sandbox is not what stops it.
    expect((await review([reviewed(1)])).verdict).not.toBeNull();
    expect(calls).toBe(1);
    expect(
      await review(Array.from({ length: MAX_REVIEW_ROUNDS }, (_, index) => reviewed(index + 1))),
    ).toEqual({ verdict: null, usage: null });
    expect(calls).toBe(1);
  });
});
