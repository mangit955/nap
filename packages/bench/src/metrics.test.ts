/**
 * Metric derivation against synthetic event streams.
 *
 * Synthetic rather than recorded, because the interesting cases are the ones a happy run
 * never produces: a turn that failed, a tool that refused, an agent that edited one file
 * eleven times. Every stream here is built from `NapEventSchema`'s own shapes, so a change
 * to the event contract breaks these tests rather than quietly changing what they measure.
 */

import { type NapEvent, type NapEventOf, NapEventSchema } from "@nap/shared/events";
import { describe, expect, it } from "vitest";
import { deriveRunMetrics, RunMetricsSchema } from "./metrics.ts";

const SESSION_ID = "3f2a1c4e-0000-4000-8000-000000000002";
const TURN_ID = "3f2a1c4e-0000-4000-8000-000000000003";

let seq = 0;

/**
 * One event, validated against the contract on the way out.
 *
 * Parsed rather than cast: a cast would let this file keep compiling — and keep asserting —
 * after the payload it builds stopped being a legal event, which is the one thing these
 * tests claim they cannot do.
 */
function event<T extends NapEvent["type"]>(type: T, payload: NapEventOf<T>["payload"]): NapEvent {
  seq++;
  return NapEventSchema.parse({
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    seq,
    createdAt: new Date(Date.UTC(2026, 7, 14, 0, 0, seq)).toISOString(),
    type,
    payload,
  });
}

// One id for every call: nothing here correlates a result to its call, and ids derived from
// the running sequence number only looked like they did.
const CALL_ID = "call_1";

const toolCall = (toolName: NapEventOf<"tool.call">["payload"]["toolName"]) =>
  event("tool.call", { toolCallId: CALL_ID, toolName, input: {} });

const toolResult = (ok: boolean) =>
  event("tool.result", { toolCallId: CALL_ID, toolName: "read_file", ok, output: "" });

const fileChanged = (path: string) =>
  event("file.changed", { path, changeType: "modified", diff: "" });

const completed = (inputTokens: number, outputTokens: number, durationMs: number) =>
  event("turn.completed", {
    usage: { inputTokens, outputTokens },
    durationMs,
    commitSha: "a".repeat(40),
  });

/** A run that went well: two tools, one command, two files, one completed turn. */
function healthyRun(): NapEvent[] {
  return [
    event("turn.started", {}),
    event("user.message", { text: "Build it." }),
    toolCall("write_file"),
    toolResult(true),
    fileChanged("/home/user/app/src/App.tsx"),
    toolCall("run_command"),
    toolResult(true),
    fileChanged("/home/user/app/src/main.tsx"),
    completed(1_000, 200, 4_000),
  ];
}

describe("deriveRunMetrics — what the log can supply", () => {
  it("counts tool calls, tool failures and commands", () => {
    const metrics = deriveRunMetrics([
      ...healthyRun(),
      toolCall("search_files"),
      toolResult(false),
    ]);

    expect(metrics.toolCalls).toBe(3);
    expect(metrics.commands).toBe(1);
    expect(metrics.toolFailures).toBe(1);
  });

  it("counts distinct files rather than change events", () => {
    // An agent that edits one file eleven times touched one file. Counting the events would
    // make thrashing read as breadth.
    const metrics = deriveRunMetrics([
      fileChanged("/home/user/app/src/App.tsx"),
      fileChanged("/home/user/app/src/App.tsx"),
      fileChanged("/home/user/app/src/main.tsx"),
    ]);

    expect(metrics.filesChanged).toBe(2);
  });

  it("counts a cancelled turn apart from a failed one", () => {
    // The log spells both `turn.failed`, and they are not the same finding: a run somebody
    // stopped is not an observation, and merging the two would hide that in the aggregate.
    const metrics = deriveRunMetrics([
      event("turn.started", {}),
      event("turn.failed", { reason: "cancelled", message: "stopped" }),
    ]);

    expect(metrics.turns).toEqual({ started: 1, completed: 0, failed: 0, cancelled: 1 });
  });

  it("counts the turn lifecycle", () => {
    const metrics = deriveRunMetrics([
      event("turn.started", {}),
      completed(10, 10, 100),
      event("turn.started", {}),
      event("turn.failed", { reason: "model_unavailable", message: "overloaded" }),
    ]);

    expect(metrics.turns).toEqual({ started: 2, completed: 1, failed: 1, cancelled: 0 });
  });

  it("sums tokens and duration across the turns that completed", () => {
    const metrics = deriveRunMetrics([completed(1_000, 200, 4_000), completed(500, 50, 1_000)]);

    expect(metrics.tokens).toEqual({ inputTokens: 1_500, outputTokens: 250 });
    expect(metrics.turnDurationMs).toBe(5_000);
  });

  it("ignores the events it has nothing to say about", () => {
    // A stream carries chat, thinking, command output and preview announcements too. None
    // of them are trajectory figures, and none of them may perturb one.
    const metrics = deriveRunMetrics([
      ...healthyRun(),
      event("agent.thinking", { text: "hmm" }),
      event("agent.message", { text: "done" }),
      event("command.output", { toolCallId: "call_1", stream: "stdout", chunk: "ok" }),
      event("preview.ready", { url: "https://5173-abc.e2b.dev", port: 5173 }),
      event("system.notice", { level: "info", text: "restored" }),
    ]);

    expect(metrics).toEqual(deriveRunMetrics(healthyRun()));
  });

  it("produces a metrics object the report schema accepts", () => {
    expect(RunMetricsSchema.safeParse(deriveRunMetrics(healthyRun())).success).toBe(true);
  });
});

describe("deriveRunMetrics — what the log cannot supply stays absent", () => {
  it("leaves agent steps absent rather than zero", () => {
    // The model loop has no event marking its boundaries, so the number is unknown. A zero
    // would say the agent made no model calls, which is false for every run that ever ran.
    const metrics = deriveRunMetrics(healthyRun());

    expect("agentSteps" in metrics).toBe(false);
    expect(metrics.agentSteps).toBeUndefined();
  });

  it("leaves retries absent rather than zero", () => {
    const metrics = deriveRunMetrics(healthyRun());

    expect("retries" in metrics).toBe(false);
    expect(metrics.retries).toBeUndefined();
  });

  it("leaves tokens, duration and cost absent on a turn that failed", () => {
    // `turn.failed` carries a reason and a message and no usage. This is the run where cost
    // is most worth knowing, and a zero would understate a failing model's spend.
    const metrics = deriveRunMetrics(
      [
        event("turn.started", {}),
        toolCall("run_command"),
        event("turn.failed", { reason: "budget_exceeded", message: "out of steps" }),
      ],
      { model: "openai/gpt-5.6-luna" },
    );

    expect("tokens" in metrics).toBe(false);
    expect("turnDurationMs" in metrics).toBe(false);
    expect("estimatedCost" in metrics).toBe(false);
    // The figures the log *does* supply for that run are still there.
    expect(metrics.toolCalls).toBe(1);
    expect(metrics.turns.failed).toBe(1);
  });

  it("survives a JSON round trip with the absent fields still absent", () => {
    // The claim is about the artefact, not the object: a key written as `undefined` would
    // disappear through JSON anyway, and one written as `null` would not.
    const metrics = deriveRunMetrics([event("turn.failed", { reason: "internal", message: "" })]);
    const readBack = JSON.parse(JSON.stringify(metrics)) as Record<string, unknown>;

    expect("agentSteps" in readBack).toBe(false);
    expect("tokens" in readBack).toBe(false);
    expect(readBack.toolCalls).toBe(0);
  });
});

describe("deriveRunMetrics — cost", () => {
  it("estimates cost from the tokens and the model it was told about", () => {
    const metrics = deriveRunMetrics([completed(1_000_000, 1_000_000, 1_000)], {
      model: "openai/gpt-5.6-luna",
    });

    expect(metrics.estimatedCost).toEqual({
      usd: 0.7,
      model: "openai/gpt-5.6-luna",
      priceTableVersion: expect.any(String),
    });
  });

  it("leaves cost absent when nobody said which model ran", () => {
    const metrics = deriveRunMetrics([completed(1_000, 200, 4_000)]);

    expect("estimatedCost" in metrics).toBe(false);
    // The tokens are still reported: only the derived figure is missing.
    expect(metrics.tokens).toEqual({ inputTokens: 1_000, outputTokens: 200 });
  });
});
