import { describe, expect, it } from "vitest";
import { parseReliabilityArgs, scriptedTestTurn } from "./computer-reliability-args.ts";

describe("parseReliabilityArgs", () => {
  it("defaults to the scripted model, every app, ten runs each", () => {
    expect(parseReliabilityArgs([])).toEqual({
      ok: true,
      value: {
        model: null,
        apps: ["cart", "notes", "kanban"],
        runs: 10,
        out: null,
        allowSpend: false,
        maxSpendUsd: null,
      },
    });
  });

  it("reads a model, a subset of apps, a run count, an output directory and spend consent", () => {
    const parsed = parseReliabilityArgs([
      "--model=anthropic/claude-sonnet-5",
      "--apps=kanban,cart",
      "--runs=3",
      "--out=somewhere",
      "--allow-spend",
      "--max-spend=1",
    ]);
    expect(parsed).toEqual({
      ok: true,
      value: {
        model: "anthropic/claude-sonnet-5",
        apps: ["kanban", "cart"],
        runs: 3,
        out: "somewhere",
        allowSpend: true,
        maxSpendUsd: 1,
      },
    });
  });

  it.each([
    ["--model=custom/text-only"],
    ["--apps=cart,unknown"],
    ["--apps="],
    ["--runs=0"],
    ["--runs=1.5"],
    ["--runs=101"],
    ["--out="],
    ["--max-spend=0"],
    ["--max-spend=lots"],
    ["--max-spend=1"],
    ["--allow-spend"],
    ["--runs=2", "--runs=3"],
    ["--verbose"],
  ])("refuses %j", (...args) => {
    expect(parseReliabilityArgs(args).ok).toBe(false);
  });
});

describe("scriptedTestTurn", () => {
  it("records setup, declares an assertion before input, and gives its verdict a step later", () => {
    const turn = scriptedTestTurn();
    const calls = turn.flatMap((response) => response.toolCalls ?? []);
    const actions = calls.map((call) => (call.input as { actions: { action: string }[] }).actions);
    expect(calls.every((call) => call.name === "computer")).toBe(true);
    // Setup and its screenshot, then the declaration and the input, then the verdict alone.
    expect(actions.map((batch) => batch.map((action) => action.action))).toEqual([
      ["annotate", "screenshot"],
      ["annotate", "annotate", "annotate", "left_click", "wait", "screenshot"],
      ["annotate"],
    ]);
    expect(turn.at(-1)?.toolCalls).toBeUndefined();
  });
});
