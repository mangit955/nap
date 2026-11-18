import { describe, expect, it } from "vitest";
import { type NapEvent, NapEventSchema } from "./events.ts";
import { sessionUsage } from "./session-usage.ts";

const ENVELOPE = {
  sessionId: "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f",
  turnId: "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f",
  createdAt: "2026-11-18T12:00:00.000Z",
} as const;
const JOB_ID = "3f9a1c2d-5e6b-4f7a-8b9c-0d1e2f3a4b5c";

/** Parsed, so every fixture is a row the event log could actually hold. */
function log(...payloads: readonly Omit<NapEvent, keyof typeof ENVELOPE | "seq">[]): NapEvent[] {
  return payloads.map((event, seq) => NapEventSchema.parse({ ...ENVELOPE, seq, ...event }));
}

/** A log written before reviews recorded their usage: one turn, a compaction inside it, a title. */
const OLD_LOG = log(
  { type: "turn.started", payload: { source: "user" } },
  // A first attempt that failed, then one that worked: both ran on the turn's provider.
  {
    type: "compaction.failed",
    payload: {
      id: JOB_ID,
      message: "truncated",
      cancelled: false,
      usage: { inputTokens: 100, outputTokens: 10 },
    },
  },
  { type: "compaction.started", payload: { id: JOB_ID, trigger: "automatic" } },
  {
    type: "compaction.completed",
    payload: {
      id: JOB_ID,
      result: { kind: "native", provider: "codex", sessionId: "thread_1", coveredThrough: 1 },
      usage: { inputTokens: 300, outputTokens: 40 },
      beforeTokens: null,
      afterTokens: null,
    },
  },
  {
    type: "subagent.completed",
    payload: {
      subagentId: JOB_ID,
      outcome: "completed",
      summary: "found it",
      toolCalls: 2,
      usage: { inputTokens: 200, outputTokens: 20 },
    },
  },
  {
    type: "turn.completed",
    payload: {
      usage: { inputTokens: 1_500, outputTokens: 160, cacheReadTokens: 1_000 },
      durationMs: 1,
      commitSha: "abc1234",
    },
  },
  {
    type: "project.renamed",
    payload: {
      name: "Streaks",
      source: "model",
      model: "openai/gpt-5.6-luna",
      usage: { inputTokens: 900, outputTokens: 6 },
    },
  },
  { type: "job.started", payload: { jobId: JOB_ID, objective: "x" } },
  {
    type: "verification.completed",
    payload: { jobId: JOB_ID, checks: [{ name: "typecheck", outcome: "passed", output: null }] },
  },
);

describe("sessionUsage", () => {
  it("adds every turn and the title, and not the calls already inside a turn's own total", () => {
    // The compactions and the helper ran on the turn's provider, so the turn's 1,500 includes them.
    expect(sessionUsage(OLD_LOG)).toEqual({
      inputTokens: 2_400,
      outputTokens: 166,
      cacheReadTokens: 1_000,
    });
  });

  it("adds a review, which runs after its turn has ended and so is in no turn's total", () => {
    const reviewed = [
      ...OLD_LOG,
      ...log({
        type: "review.completed",
        payload: { jobId: JOB_ID, usage: { inputTokens: 4_000, outputTokens: 300 } },
      }),
    ];
    expect(sessionUsage(reviewed)).toEqual({
      inputTokens: 6_400,
      outputTokens: 466,
      cacheReadTokens: 1_000,
    });
  });

  it("is zero for a session that has spent nothing", () => {
    expect(sessionUsage([])).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});
