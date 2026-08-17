import type { NapEvent } from "@nap/shared/events";
import { describe, expect, it } from "vitest";
import {
  type BenchTrajectory,
  parseBenchTrajectory,
  serialiseBenchTrajectory,
} from "./trajectory.ts";

const envelope = {
  sessionId: "3f2a1c4e-0000-4000-8000-000000000002",
  turnId: "3f2a1c4e-0000-4000-8000-000000000003",
  createdAt: "2026-08-14T00:00:00.000Z",
};

const events: NapEvent[] = [
  { ...envelope, seq: 1, type: "turn.started", payload: { source: "user" } },
  { ...envelope, seq: 2, type: "agent.thinking", payload: { text: "hmm" } },
  {
    ...envelope,
    seq: 3,
    type: "turn.completed",
    payload: {
      usage: { inputTokens: 900, outputTokens: 40 },
      durationMs: 3_000,
      commitSha: null,
    },
  },
];

const trajectory: BenchTrajectory = {
  runId: "3f2a1c4e-0000-4000-8000-000000000001",
  taskId: "landing-page",
  sessionId: envelope.sessionId,
  events,
};

describe("a trajectory", () => {
  it("round-trips through serialisation unchanged", () => {
    const parsed = parseBenchTrajectory(JSON.parse(serialiseBenchTrajectory(trajectory)));

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value).toEqual(trajectory);
  });

  it("keeps the stream whole, including what today's metrics ignore", () => {
    // The thinking block counts towards nothing. It is kept because the run somebody
    // re-reads is the one whose score surprised them, and that is what they read.
    const parsed = parseBenchTrajectory(JSON.parse(serialiseBenchTrajectory(trajectory)));
    if (!parsed.ok) throw new Error(parsed.error);

    expect(parsed.value.events.map((event) => event.type)).toEqual([
      "turn.started",
      "agent.thinking",
      "turn.completed",
    ]);
  });

  it("is written compactly, unlike a report", () => {
    // A report is read by people and diffed line by line; a trajectory is machine input,
    // and a long agentic run indented to two spaces is a file nobody can open.
    expect(serialiseBenchTrajectory(trajectory)).not.toContain("\n  ");
  });

  it("refuses an event that is not in the contract", () => {
    // An archived stream is untrusted input by the time two of them are compared, and the
    // event contract is exactly the thing that may have moved on since it was written.
    const bogus = { ...trajectory, events: [{ ...envelope, seq: 1, type: "agent.step" }] };

    expect(parseBenchTrajectory(bogus).ok).toBe(false);
  });

  it("carries the ids that match it back to its report", () => {
    expect(trajectory.runId).not.toBe(trajectory.sessionId);
    expect(parseBenchTrajectory({ ...trajectory, runId: "not-a-uuid" }).ok).toBe(false);
  });
});
