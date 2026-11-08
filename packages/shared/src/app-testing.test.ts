import { describe, expect, it } from "vitest";
import { appTestTarget, failedAppTestGoal } from "./app-testing.ts";
import type { StoredEvent } from "./ports/event-store.ts";

const base = { sessionId: "s", turnId: "t", createdAt: "2026-10-24T00:00:00Z" };
const events: StoredEvent[] = [
  { ...base, seq: 1, type: "job.started", payload: { jobId: "job", objective: "Save notes" } },
  {
    ...base,
    seq: 2,
    type: "turn.completed",
    payload: { usage: { inputTokens: 0, outputTokens: 0 }, durationMs: 0, commitSha: "abcdef1" },
  },
  { ...base, seq: 3, type: "job.checkpointed", payload: { jobId: "job", commitSha: "abcdef1" } },
  { ...base, seq: 4, type: "job.completed", payload: { jobId: "job", outcome: "verified" } },
];
it("selects only the newest completed job at its own checkpoint and finds its diff base", () => {
  expect(appTestTarget(events)).toMatchObject({
    jobId: "job",
    goal: "Save notes",
    commitSha: "abcdef1",
    baseRevision: "abcdef1^",
  });
  expect(appTestTarget([])).toBeUndefined();
  expect(appTestTarget(events.slice(0, 3))).toBeUndefined();
  expect(
    appTestTarget([
      ...events,
      { ...base, seq: 5, type: "job.started", payload: { jobId: "later", objective: "Other" } },
    ]),
  ).toBeUndefined();
  expect(
    appTestTarget([
      ...events,
      {
        ...base,
        seq: 5,
        type: "turn.completed",
        payload: {
          usage: { inputTokens: 0, outputTokens: 0 },
          durationMs: 0,
          commitSha: "different",
        },
      },
    ]),
  ).toBeUndefined();
});

it("judges a job Fix it opened by the goal it carries, not by the repair prompt that opened it", () => {
  const repair = events.map((event) =>
    event.type === "job.started"
      ? {
          ...event,
          payload: { jobId: "job", objective: "Fix the failures found…", goal: "Save notes" },
        }
      : event,
  );
  expect(appTestTarget(repair)?.goal).toBe("Save notes");
  // A log written before `goal` existed: the objective is the goal, as it always was.
  expect(appTestTarget(events)?.goal).toBe("Save notes");
});

describe("failedAppTestGoal", () => {
  const test = { sessionId: "s", turnId: "test", createdAt: "2026-10-24T00:00:00Z" };
  const started: StoredEvent = {
    ...test,
    seq: 5,
    type: "test.started",
    payload: { jobId: "job", commitSha: "abcdef1", objective: "Save notes" },
  };
  const completed = (failed: number): StoredEvent => ({
    ...test,
    seq: 6,
    type: "test.completed",
    payload: { jobId: "job", status: "completed", counts: { passed: 0, failed, untested: 0 } },
  });

  it("is the goal a finished test with a failure was judged against", () => {
    expect(failedAppTestGoal([...events, started, completed(1)], "test")).toBe("Save notes");
  });

  it("is nothing for a test that failed nothing, is still running, or is not in the log", () => {
    expect(failedAppTestGoal([...events, started, completed(0)], "test")).toBeUndefined();
    expect(failedAppTestGoal([...events, started], "test")).toBeUndefined();
    expect(failedAppTestGoal([...events, started, completed(1)], "other")).toBeUndefined();
    // A user turn under the same id is not a test, whatever it says.
    expect(failedAppTestGoal(events, "t")).toBeUndefined();
  });
});
