import { expect, it } from "vitest";
import { appTestTarget } from "./app-testing.ts";
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
    objective: "Save notes",
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
