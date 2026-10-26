import type { StoredEvent } from "@nap/shared/ports/event-store";
import { expect, it } from "vitest";
import { appTestRepairPrompt, foldAppTests } from "./app-test-state.ts";

const base = { sessionId: "s", turnId: "test-turn", createdAt: "2026-10-24T00:00:00Z" };
export const testEvents: StoredEvent[] = [
  {
    ...base,
    seq: 1,
    type: "test.started",
    payload: { jobId: "job", commitSha: "abcdef1", objective: "Save notes" },
  },
  {
    ...base,
    seq: 2,
    type: "test.annotation",
    payload: {
      annotation: {
        type: "assertion",
        id: "save",
        expectation: "The saved note appears",
        result: "untested",
      },
      timeMs: 0,
    },
  },
  {
    ...base,
    seq: 3,
    type: "test.annotation",
    payload: {
      annotation: {
        type: "assertion",
        id: "save",
        expectation: "The saved note appears",
        result: "failed",
      },
      timeMs: 1000,
    },
  },
  {
    ...base,
    seq: 4,
    type: "test.completed",
    payload: { jobId: "job", status: "completed", counts: { passed: 0, failed: 1, untested: 0 } },
  },
];
it("folds declaration and verdict into one assertion and builds repair data only on request", () => {
  const tests = foldAppTests(testEvents);
  expect(tests).toHaveLength(1);
  expect(tests[0]?.assertions).toHaveLength(1);
  expect(tests[0]?.counts).toEqual({ passed: 0, failed: 1, untested: 0 });
  const test = tests[0];
  if (!test) throw new Error("missing test");
  expect(appTestRepairPrompt(test)).toContain("The saved note appears");
  expect(appTestRepairPrompt(test)).toContain("Save notes");
  expect(appTestRepairPrompt({ ...test, status: "running" })).toBeUndefined();
  expect(appTestRepairPrompt({ ...test, assertions: [] })).toBeUndefined();
});
it("keeps interrupted and orphan results readable without inventing repair context", () => {
  const orphan = foldAppTests(testEvents.slice(-1))[0];
  expect(orphan?.objective).toBeNull();
  if (!orphan) throw new Error("missing orphan");
  expect(appTestRepairPrompt(orphan)).toBeUndefined();
  expect(foldAppTests(testEvents.slice(0, 2))[0]?.counts).toEqual({
    passed: 0,
    failed: 0,
    untested: 1,
  });
});

it("retains the complete annotation timeline and the latest recording state", () => {
  const source: StoredEvent[] = [
    testEvents[0]!,
    { ...base, seq: 2, type: "test.recording", payload: { recording: { state: "started" } } },
    ...testEvents.slice(1, 3),
    {
      ...base,
      seq: 5,
      type: "test.recording",
      payload: {
        recording: {
          state: "available",
          key: "computer/p/s/t/recording.mp4",
          durationMs: 1200,
          width: 1024,
          height: 768,
          interrupted: false,
        },
      },
    },
    testEvents[3]!,
  ];
  const log = source.map((event, index) => ({ ...event, seq: index + 1 }));
  const test = foldAppTests(log)[0];
  expect(test?.annotations).toHaveLength(2);
  expect(test?.annotations.map((entry) => entry.timeMs)).toEqual([0, 1000]);
  expect(test?.recording).toMatchObject({ state: "available", durationMs: 1200 });
  expect(
    foldAppTests([
      ...log,
      {
        ...base,
        seq: 7,
        type: "test.recording",
        payload: { recording: { state: "unavailable", reason: "timing_failed" } },
      },
    ])[0]?.recording,
  ).toEqual({ state: "unavailable", reason: "timing_failed" });
});
it("keeps historical tests unrecorded and ignores recording metadata without a test start", () => {
  expect(foldAppTests(testEvents)[0]?.recording).toEqual({ state: "none" });
  expect(
    foldAppTests([
      { ...base, seq: 1, type: "test.recording", payload: { recording: { state: "started" } } },
    ]),
  ).toEqual([]);
});
