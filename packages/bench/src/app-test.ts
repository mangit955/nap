import { modelSupportsImages } from "@nap/shared/model-capabilities";
import type { EventStore, StoredEvent } from "@nap/shared/ports/event-store";
import type { Runtime, TurnOutcome } from "@nap/shared/ports/runtime";
import { z } from "zod";

export type AppTestTask = {
  id: string;
  fixture: "notes" | "cart";
  variant: "correct" | "buggy";
  expected: "passed" | "failed";
  objective: string;
  flowId: string;
  assertionId: string;
};

const notes = {
  fixture: "notes",
  objective:
    'A notes app. Saving a note adds it to the list and keeps it after reloading. Test that flow with chapter id "save-note" and assertion id "saved-note-persists".',
  flowId: "save-note",
  assertionId: "saved-note-persists",
} as const;
const cart = {
  fixture: "cart",
  objective:
    'A cart for a $12 notebook. Changing quantity updates the total to price times quantity. Test that flow with chapter id "change-quantity" and assertion id "quantity-total".',
  flowId: "change-quantity",
  assertionId: "quantity-total",
} as const;

/** Separate from the frozen generation suites. Expected verdicts never enter a runtime request. */
export const APP_TEST_TASKS: readonly AppTestTask[] = [
  { ...notes, id: "notes-correct", variant: "correct", expected: "passed" },
  { ...notes, id: "notes-buggy", variant: "buggy", expected: "failed" },
  { ...cart, id: "cart-correct", variant: "correct", expected: "passed" },
  { ...cart, id: "cart-buggy", variant: "buggy", expected: "failed" },
];

type Target = { sessionId: string; turnId: string; jobId: string; commitSha: string };
export type AppTestAssessment =
  | { status: "measured"; score: 0 | 1; observed: "passed" | "failed" }
  | { status: "unmeasured"; score: null; reason: string };

/** Grade recorded assertions, never the model's prose or the runtime's aggregate alone. */
export function evaluateAppTest(
  options: Target & {
    task: AppTestTask;
    events: readonly StoredEvent[];
    outcome: TurnOutcome;
  },
): AppTestAssessment {
  const { task, outcome } = options;
  const missing = (reason: string): AppTestAssessment => ({
    status: "unmeasured",
    score: null,
    reason,
  });
  if (!outcome.ok || outcome.turnId !== options.turnId || outcome.commitSha !== null)
    return missing("The test turn did not complete without a source commit.");
  const log = options.events.filter(
    (event) => event.sessionId === options.sessionId && event.turnId === options.turnId,
  );
  const starts = log.filter((event) => event.type === "test.started");
  const ends = log.filter((event) => event.type === "test.completed");
  const turns = log.filter((event) => event.type === "turn.started");
  const completed = log.filter((event) => event.type === "turn.completed");
  const start = starts[0];
  const end = ends[0];
  if (
    starts.length !== 1 ||
    ends.length !== 1 ||
    !start ||
    !end ||
    start.payload.jobId !== options.jobId ||
    start.payload.commitSha !== options.commitSha ||
    end.payload.jobId !== options.jobId ||
    end.payload.status !== "completed" ||
    turns.length !== 1 ||
    turns[0]?.payload.source !== "test" ||
    completed.length !== 1 ||
    completed[0]?.payload.commitSha !== null
  )
    return missing("Missing or mismatched test lifecycle/checkpoint.");
  if (
    log.some(
      (event) =>
        event.type === "turn.failed" ||
        event.type === "file.changed" ||
        (event.type === "tool.result" && !event.payload.ok),
    )
  )
    return missing("Runtime, tool or capture failure, or source modification.");
  if (!log.some((event) => event.type === "computer.screenshot"))
    return missing("No stored screenshot observation.");

  let chapter: string | null = null;
  const assertions = new Map<
    string,
    { chapter: string; result: "passed" | "failed" | "untested" }
  >();
  for (const event of log) {
    if (event.type !== "test.annotation") continue;
    const annotation = event.payload.annotation;
    if (annotation.type === "test_start") chapter = annotation.id;
    if (annotation.type !== "assertion") continue;
    if (!chapter || !annotation.expectation.trim()) return missing("Empty or unscoped assertion.");
    assertions.set(annotation.id, { chapter, result: annotation.result });
  }
  const counts = { passed: 0, failed: 0, untested: 0 };
  for (const assertion of assertions.values()) counts[assertion.result] += 1;
  if (
    assertions.size === 0 ||
    counts.untested > 0 ||
    counts.passed !== end.payload.counts.passed ||
    counts.failed !== end.payload.counts.failed ||
    counts.untested !== end.payload.counts.untested
  )
    return missing("Empty, untested or inconsistent assertion outcomes.");
  const target = assertions.get(task.assertionId);
  if (!target || target.chapter !== task.flowId || target.result === "untested")
    return missing("The designated app flow has no completed assertion.");
  return {
    status: "measured",
    score:
      target.result === task.expected && (task.expected === "failed" || counts.failed === 0)
        ? 1
        : 0,
    observed: target.result,
  };
}

/** No generation/repair turn is allowed before the planted app test. */
export async function runAppTest(
  options: Target & {
    task: AppTestTask;
    runtime: Runtime;
    events: EventStore;
    model: string;
  },
) {
  let outcome: TurnOutcome;
  try {
    outcome = await options.runtime.runTurn({
      kind: "test",
      sessionId: options.sessionId,
      turnId: options.turnId,
      jobId: options.jobId,
      model: options.model,
    });
  } catch (error) {
    outcome = {
      ok: false,
      turnId: options.turnId,
      reason: "internal",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  const events = await options.events.readFrom(options.sessionId, 0);
  return { outcome, events, assessment: evaluateAppTest({ ...options, outcome, events }) };
}

/** Strict free-by-default CLI parsing happens before any composition or credential loading. */
export function parseAppTestArgs(args: readonly string[]) {
  let real = false;
  let taskId: string | null = null;
  let out = "napbench-results/app-test.json";
  const seen = new Set<string>();
  const paid = new Map<string, string>();
  const paidFlags = [
    "--model",
    "--max-steps",
    "--max-tokens",
    "--budget-tokens",
    "--max-output-tokens",
    "--effort",
    "--template",
  ];
  for (const arg of args) {
    const flag = arg.split("=")[0] ?? "";
    if (seen.has(flag)) throw new Error(`Duplicate flag: ${flag}`);
    seen.add(flag);
    if (arg === "--real") real = true;
    else if (arg.startsWith("--task=") && APP_TEST_TASKS.some((task) => task.id === arg.slice(7)))
      taskId = arg.slice(7);
    else if (arg.startsWith("--out=") && arg.slice(6).trim()) out = arg.slice(6);
    else if (
      paidFlags.includes(flag) &&
      arg.startsWith(`${flag}=`) &&
      arg.slice(flag.length + 1).trim()
    )
      paid.set(flag, arg.slice(flag.length + 1));
    else throw new Error(`Unknown or invalid argument: ${arg}`);
  }
  if (!real) {
    if (paid.size) throw new Error("Model, template and limit flags require --real.");
    return { real: false as const, taskId, out };
  }
  const require = (flag: string) => {
    const value = paid.get(flag);
    if (!value) throw new Error(`Real app tests require explicit ${flag}.`);
    return value;
  };
  const integer = (flag: string) => {
    const value = require(flag);
    const parsed = Number(value);
    if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(parsed))
      throw new Error(`${flag} must be a positive safe integer.`);
    return parsed;
  };
  const model = require("--model");
  if (!modelSupportsImages(model))
    throw new Error("--model must name a supported, canonical image-capable model.");
  const maxSteps = integer("--max-steps");
  const maxTokens = integer("--max-tokens");
  const budgetTokens = integer("--budget-tokens");
  const maxOutputTokens = integer("--max-output-tokens");
  if (budgetTokens > maxTokens || maxOutputTokens > maxTokens)
    throw new Error("Context and output limits must not exceed --max-tokens.");
  const effort = z
    .enum(["low", "medium", "high", "xhigh", "max"])
    .parse(paid.get("--effort") ?? "medium");
  const template = paid.get("--template");
  if (template && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(template))
    throw new Error("Invalid --template name or ID.");
  return {
    real: true as const,
    taskId,
    out,
    model,
    maxSteps,
    maxTokens,
    budgetTokens,
    maxOutputTokens,
    effort,
    template,
  };
}
