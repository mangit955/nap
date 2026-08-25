/**
 * The one thing the TypeScript half and the Python half have to agree about.
 *
 * A generated instruction carries the task id as a marker, and the Harbor agent reads it back
 * out with a regular expression written in another language, checked by another toolchain, in
 * a directory `bun run test` does not otherwise reach. Nothing but this test would notice the
 * two drifting apart — and the symptom would be every trial refusing to start, discovered
 * after the harness had been pointed at a suite.
 *
 * The Python is read as text rather than executed, because this suite has no Python.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BENCH_TASKS } from "@nap/bench/suite";
import { benchReport } from "@nap/bench/testing/bench-report";
import { describe, expect, it } from "vitest";
import { taskMarker } from "./harbor-task.ts";

const REPO_ROOT = join(import.meta.dirname, "..", "..", "..");
const TRIAL_PY = join(REPO_ROOT, "harbor", "napbench_harbor", "trial.py");

/** The pattern the agent matches an instruction with, lifted out of the Python source. */
function pythonMarkerPattern(): RegExp {
  const source = readFileSync(TRIAL_PY, "utf8");
  const declaration = /TASK_MARKER_PATTERN = re\.compile\(r"(.+)"\)/.exec(source);
  if (declaration === null) {
    throw new Error(`no TASK_MARKER_PATTERN in ${TRIAL_PY} — has the Python agent moved?`);
  }

  return new RegExp(declaration[1] as string);
}

describe("the marker the two halves of the harness share", () => {
  it("matches what the generator writes, for every task in the registry", () => {
    const pattern = pythonMarkerPattern();

    for (const task of BENCH_TASKS) {
      const match = pattern.exec(taskMarker(task.id));
      expect(match?.[1], `the Python agent cannot read ${task.id}'s marker`).toBe(task.id);
    }
  });

  it("does not match an instruction that names no task", () => {
    expect(pythonMarkerPattern().test("# Build me a to-do list\n")).toBe(false);
  });
});

/**
 * The second thing that crosses the language boundary: the agent reads a finished report to
 * tell the harness what the run cost, and does it by field name. A rename in the report schema
 * would silently zero those figures rather than fail anything — the same class of drift as the
 * marker, and invisible for longer, since a missing cost looks like a run nobody priced.
 */
describe("the report fields the Python agent reads back", () => {
  it("all exist on a report this repository writes", () => {
    const source = readFileSync(TRIAL_PY, "utf8");
    const read = source.slice(source.indexOf("def context_from_report"));

    const report = benchReport({
      metrics: {
        toolCalls: 1,
        toolFailures: 0,
        commands: 0,
        filesChanged: 1,
        turns: { started: 1, completed: 1, failed: 0, cancelled: 0 },
        tokens: { inputTokens: 10, outputTokens: 2 },
        estimatedCost: { usd: 0.01, model: "m", priceTableVersion: "1" },
      },
    });

    // Every quoted key in the function, checked against a real report rather than against a
    // list somebody would have to remember to update. Names with an underscore are skipped
    // because those are the *harness's* field names — the report's are all camelCase, which is
    // what makes the two tellable apart without a list of either.
    const keys = [...read.matchAll(/"([A-Za-z][A-Za-z0-9]*)"/g)].map(([, key]) => key as string);
    expect(keys.length, "no keys found — has context_from_report been rewritten?").toBeGreaterThan(
      3,
    );

    for (const key of keys) {
      expect(
        JSON.stringify(report).includes(`"${key}"`),
        `the Python agent reads "${key}", which no report carries`,
      ).toBe(true);
    }
  });
});
