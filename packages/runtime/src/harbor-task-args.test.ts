import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HARBOR_TASK_DEFAULTS,
  HARBOR_TASK_FILES,
  parseHarborTaskArgs,
  SCRIPTED_MODEL,
} from "./harbor-task-args.ts";
import { TaskTurnResultSchema } from "./task-turn.ts";

const HARBOR = join(import.meta.dirname, "..", "..", "..", "harbor", "nap_harbor");

describe("parseHarborTaskArgs", () => {
  it("runs a free model with the default step budget", () => {
    expect(parseHarborTaskArgs(["--job-dir=/jobs/t1/agent", "--model=vendor/m:free"])).toEqual({
      ok: true,
      value: {
        jobDir: "/jobs/t1/agent",
        model: "vendor/m:free",
        maxSteps: HARBOR_TASK_DEFAULTS.maxSteps,
        spend: false,
        scripted: false,
        review: false,
      },
    });
  });

  it("reviews only when --review asks for it", () => {
    expect(parseHarborTaskArgs(["--job-dir=/j", "--model=a/b:free", "--review"])).toMatchObject({
      ok: true,
      value: { review: true },
    });
  });

  it("runs the scripted model under its own name whatever --model said, without spending", () => {
    // The Python side always passes a model, so --scripted has to win over it: a result that
    // named the real model would be priced as a real run.
    expect(
      parseHarborTaskArgs(["--job-dir=/j", "--model=openai/gpt-6-luna", "--scripted"]),
    ).toMatchObject({ ok: true, value: { model: SCRIPTED_MODEL, scripted: true, spend: false } });
  });

  it("refuses a model that costs money unless --spend asks for it", () => {
    const refused = parseHarborTaskArgs(["--job-dir=/j", "--model=openai/gpt-5.6-luna"]);
    expect(refused).toMatchObject({ ok: false });
    expect(refused.ok ? "" : refused.error).toContain("--spend");

    expect(
      parseHarborTaskArgs(["--job-dir=/j", "--model=openai/gpt-5.6-luna", "--spend"]),
    ).toMatchObject({ ok: true, value: { spend: true } });
  });

  it.each([
    [["--model=v/m:free"], "--job-dir is required"],
    [["--job-dir=/j"], "--model is required"],
    [["--job-dir=/j", "--model=v/m:free", "--max-steps=0"], "max-steps"],
    [["--job-dir=/j", "--model=v/m:free", "--max-stpes=5"], "unknown flag"],
    [["--job-dir=/j", "--model=v/m:free", "stray"], "unexpected argument"],
  ])("refuses %j", (argv, message) => {
    const parsed = parseHarborTaskArgs(argv);
    expect(parsed.ok ? "" : parsed.error).toContain(message);
  });
});

/**
 * The Python half that starts the entrypoint and reads what it leaves is not something any gate
 * here can import, so what the two must agree on is read as text, the way
 * apps/napbench/src/harbor-agreement.test.ts does for the older adapter.
 */
describe("agreement with harbor/nap_harbor", () => {
  const trial = readFileSync(join(HARBOR, "trial.py"), "utf8");

  it.each(Object.entries(HARBOR_TASK_FILES))("names the %s file the same", (_kind, name) => {
    expect(trial).toContain(`"${name}"`);
  });

  it("starts the entrypoint that exists", () => {
    expect(trial).toContain('Path("packages") / "runtime" / "scripts" / "harbor-task.ts"');
    expect(() =>
      readFileSync(join(import.meta.dirname, "..", "scripts", "harbor-task.ts")),
    ).not.toThrow();
  });

  it("writes a result the Python half's example matches", () => {
    const example: unknown = JSON.parse(readFileSync(join(HARBOR, "result-example.json"), "utf8"));
    expect(TaskTurnResultSchema.safeParse(example).success).toBe(true);
  });
});
