import { describe, expect, it } from "vitest";
import { NAPBENCH_DEFAULTS, parseNapBenchArgs } from "./cli.ts";

function parsed(...argv: string[]) {
  const result = parseNapBenchArgs(argv);
  if (!result.ok) throw new Error(`expected a parse, got: ${result.error}`);
  return result.value;
}

function rejected(...argv: string[]): string {
  const result = parseNapBenchArgs(argv);
  if (result.ok) throw new Error("expected the arguments to be refused");
  return result.error;
}

describe("parseNapBenchArgs", () => {
  it("takes a bare word as the task to run", () => {
    expect(parsed("todo-crud").selection).toEqual({ kind: "task", taskId: "todo-crud" });
  });

  it("takes --suite as the suite to run", () => {
    expect(parsed("--suite=all").selection).toEqual({ kind: "suite", suiteName: "all" });
  });

  it("refuses being given both a task and a suite", () => {
    // Silently preferring one would run something other than what was asked for, on a run
    // that may cost money.
    expect(rejected("todo-crud", "--suite=all")).toMatch(/task or a suite/);
  });

  it("refuses being given neither", () => {
    expect(rejected("--real")).toMatch(/task or a suite/);
  });

  it("refuses two tasks", () => {
    expect(rejected("todo-crud", "landing-page")).toMatch(/one task/);
  });

  it("refuses a suite with no name", () => {
    expect(rejected("--suite")).toMatch(/suite needs a name/);
  });

  it("is a dry run unless --real is given", () => {
    // The default is the one that decides whether money is spent, so it is asserted
    // directly rather than implied by the others.
    expect(parsed("todo-crud").real).toBe(false);
    expect(parsed("--real", "todo-crud").real).toBe(true);
  });

  it("defaults a real run to the cheap configuration", () => {
    const options = parsed("--real", "todo-crud");

    expect(options.model).toBe(NAPBENCH_DEFAULTS.model);
    expect(options.platform).toBe(NAPBENCH_DEFAULTS.platform);
    expect(options.effort).toBe(NAPBENCH_DEFAULTS.effort);
    expect(options.maxSteps).toBe(NAPBENCH_DEFAULTS.maxSteps);
    expect(options.budgetTokens).toBe(NAPBENCH_DEFAULTS.budgetTokens);
  });

  it("accepts overrides for the model, platform, effort and ceilings", () => {
    expect(
      parsed(
        "--real",
        "--suite=all",
        "--platform=anthropic",
        "--model=claude-opus-5",
        "--effort=xhigh",
        "--max-steps=30",
        "--budget-tokens=90000",
        "--keep",
      ),
    ).toStrictEqual({
      selection: { kind: "suite", suiteName: "all" },
      real: true,
      platform: "anthropic",
      model: "claude-opus-5",
      effort: "xhigh",
      maxSteps: 30,
      budgetTokens: 90_000,
      keep: true,
    });
  });

  it("refuses an unknown flag rather than ignoring it", () => {
    // A forgiving parser would let `--budget-tokens` be mistyped on a paid run and quietly
    // use the default, which is the expensive kind of silence.
    expect(rejected("--budget-tokes=10", "todo-crud")).toMatch(/unknown flag --budget-tokes/);
  });

  it("refuses a ceiling that is not a positive whole number", () => {
    expect(rejected("--max-steps=zero", "todo-crud")).toMatch(/max-steps/);
    expect(rejected("--budget-tokens=-1", "todo-crud")).toMatch(/budget-tokens/);
  });

  it("refuses an effort level and a platform it does not know", () => {
    expect(rejected("--effort=maximum", "todo-crud")).toMatch(/effort must be one of/);
    expect(rejected("--platform=openai", "todo-crud")).toMatch(/platform must be one of/);
  });
});
