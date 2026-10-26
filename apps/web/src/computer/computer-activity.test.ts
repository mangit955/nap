import { expect, it } from "vitest";
import { ev, SESSION_ID } from "../testing/events.ts";
import { computerIsBusy } from "./computer-activity.ts";

const older = "00000000-0000-4000-8000-000000000001";
const testTurn = "00000000-0000-4000-8000-000000000003";
const jobId = "00000000-0000-4000-8000-000000000002";
const events = [
  ev("user.message", { text: "old request" }, 1, { turnId: older }),
  ev("turn.started", { source: "user" }, 2),
  ev(
    "turn.completed",
    { commitSha: "abcdef1", usage: { inputTokens: 0, outputTokens: 0 }, durationMs: 1 },
    3,
  ),
];
const idle = { sessionId: SESSION_ID, running: false, idleThroughSeq: 3 };
it("retires legacy unfinished turns only through the shared authoritative idle prefix", () => {
  expect(computerIsBusy({ sessionId: SESSION_ID, events, activity: null })).toBe(true);
  expect(computerIsBusy({ sessionId: SESSION_ID, events, activity: idle })).toBe(false);
  expect(
    computerIsBusy({ sessionId: SESSION_ID, events, activity: { ...idle, sessionId: "other" } }),
  ).toBe(true);
  expect(
    computerIsBusy({ sessionId: SESSION_ID, events, activity: { ...idle, running: true } }),
  ).toBe(true);
});
it("keeps a new capture busy through turn completion and retires old unfinished tests", () => {
  const started = ev("test.started", { jobId, commitSha: "abcdef1", objective: "Save" }, 4, {
    turnId: testTurn,
  });
  const completed = ev(
    "turn.completed",
    { commitSha: "abcdef1", usage: { inputTokens: 0, outputTokens: 0 }, durationMs: 1 },
    5,
    { turnId: testTurn },
  );
  const testDone = ev(
    "test.completed",
    { jobId, status: "completed", counts: { passed: 1, failed: 0, untested: 0 } },
    6,
    { turnId: testTurn },
  );
  expect(
    computerIsBusy({
      sessionId: SESSION_ID,
      events: [...events, started, completed],
      activity: idle,
    }),
  ).toBe(true);
  expect(
    computerIsBusy({
      sessionId: SESSION_ID,
      events: [...events, started, completed, testDone],
      activity: idle,
    }),
  ).toBe(false);
  expect(
    computerIsBusy({
      sessionId: SESSION_ID,
      events: [...events, started, completed],
      activity: { ...idle, idleThroughSeq: 5 },
    }),
  ).toBe(false);
  expect(
    computerIsBusy({
      sessionId: SESSION_ID,
      events: [started],
      activity: { ...idle, sessionId: "other", idleThroughSeq: 10 },
    }),
  ).toBe(true);
});
