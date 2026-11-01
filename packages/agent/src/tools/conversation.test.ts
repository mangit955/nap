import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { NapEventSchema } from "@nap/shared/events";
import type { PendingEvent } from "@nap/shared/ports/event-store";
import { describe, expect, it } from "vitest";
import { executeTool } from "./execute.ts";

const SESSION = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";
const TURN = "7c9b1a52-8d3e-4f21-a0c4-1b2d3e4f5a6b";

async function run(name: string, input: Record<string, unknown>) {
  const events: PendingEvent[] = [];
  const outcome = await executeTool(
    { id: "toolu_x", name, input },
    {
      sessionId: SESSION,
      turnId: TURN,
      sandboxId: "unused",
      sandbox: new InMemorySandboxManager(),
      emit: (event) => events.push(event as PendingEvent),
      now: () => "2026-01-01T00:00:00.000Z",
    },
  );
  return { outcome, events };
}

const PLAN = [
  { content: "Add the list", status: "completed" },
  { content: "Style it", status: "in_progress" },
  { content: "Empty state", status: "pending" },
];

describe("todo_write", () => {
  it("puts the plan in the log, between its call and its result", async () => {
    const { outcome, events } = await run("todo_write", { todos: PLAN });

    expect(outcome).toEqual({ ok: true, output: expect.stringMatching(/1 of 3 done/) });
    expect(events.map((event) => event.type)).toEqual(["tool.call", "plan.updated", "tool.result"]);
    expect(events[1]?.payload).toEqual({ toolCallId: "toolu_x", items: PLAN });
    for (const [seq, event] of events.entries())
      expect(NapEventSchema.safeParse({ ...event, seq }).success).toBe(true);
  });

  it("refuses a plan with two things in progress at once, and logs no plan", async () => {
    const { outcome, events } = await run("todo_write", {
      todos: PLAN.map((item) => ({ ...item, status: "in_progress" })),
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.output).toMatch(/exactly one in_progress/);
    expect(events.map((event) => event.type)).not.toContain("plan.updated");
  });

  it("accepts an empty plan, which is how a model clears one", async () => {
    const { outcome } = await run("todo_write", { todos: [] });
    expect(outcome.ok).toBe(true);
  });
});

describe("ask_user", () => {
  const QUESTION = {
    question: "Grid or list?",
    options: [
      { label: "Grid", description: "Cards in columns" },
      { label: "List", description: null },
    ],
    multiSelect: false,
  };

  it("puts the question in the log and ends the turn", async () => {
    const { outcome, events } = await run("ask_user", QUESTION);

    expect(outcome.ok).toBe(true);
    expect(outcome.ok && outcome.endsTurn).toBe(true);
    expect(events.map((event) => event.type)).toEqual([
      "tool.call",
      "agent.question",
      "tool.result",
    ]);
    expect(events[1]?.payload).toEqual({ toolCallId: "toolu_x", ...QUESTION });
  });

  it("refuses two options a person could not tell apart", async () => {
    const { outcome, events } = await run("ask_user", {
      ...QUESTION,
      options: [
        { label: "Grid", description: null },
        { label: "grid", description: null },
      ],
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok || outcome.endsTurn).toBeFalsy();
    expect(events.map((event) => event.type)).not.toContain("agent.question");
  });

  it("refuses a question with one option, which is not a question", async () => {
    const { outcome } = await run("ask_user", { ...QUESTION, options: [QUESTION.options[0]] });
    expect(outcome.ok).toBe(false);
  });
});

describe("helpers without a runner", () => {
  it.each([
    ["run_subagent", { profile: "explore", task: "find it" }],
    ["read_subagent", { subagent_id: "helper-1" }],
  ])("%s says helpers are unavailable rather than failing the turn", async (name, input) => {
    const { outcome } = await run(name, input);
    expect(outcome).toEqual({ ok: false, output: "Helpers are not available in this turn." });
  });
});
