import { expect, it } from "vitest";
import { TestRecordingStateSchema } from "./test-recording.ts";

const states = [
  { state: "started" },
  {
    state: "available",
    key: "computer/p/s/t/recording.mp4",
    durationMs: 1200,
    width: 1024,
    height: 768,
    interrupted: false,
  },
  { state: "unavailable", reason: "timing_failed" },
];
it.each(states)("round trips recording state %j", (state) => {
  expect(TestRecordingStateSchema.parse(JSON.parse(JSON.stringify(state)))).toStrictEqual(state);
});
it.each([
  { state: "started", password: "never log credentials" },
  { state: "available", key: "", durationMs: 1000, width: 1024, height: 768, interrupted: false },
  { state: "available", key: "clip", durationMs: 0, width: 1024, height: 768, interrupted: false },
  {
    state: "available",
    key: "clip",
    durationMs: 605001,
    width: 1024,
    height: 768,
    interrupted: false,
  },
  {
    state: "available",
    key: "clip",
    durationMs: 1000,
    width: 1025,
    height: 768,
    interrupted: false,
  },
  { state: "available", key: "clip", durationMs: 1000, width: 1024, height: 0, interrupted: false },
  {
    state: "available",
    key: "clip",
    durationMs: 1000,
    width: 1024,
    height: 769,
    interrupted: false,
  },
  { state: "available", key: "clip", durationMs: 1000, width: 0, height: 768, interrupted: false },
  { state: "available", key: "clip", durationMs: 1000, width: 1024, height: 768 },
  { state: "unavailable", reason: "raw private error" },
])("rejects malformed or private recording metadata %j", (state) => {
  expect(TestRecordingStateSchema.safeParse(state).success).toBe(false);
});
