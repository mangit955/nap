/**
 * A report to write tests against, with only the fields a test cares about spelled out.
 *
 * Reports are the widest value in the package — three ids, a status, a kind, gates, a cap, a
 * score, categories, weights, checks, metrics, screenshots and a visual verdict — and almost
 * every test of the things that *read* one cares about two of those fields. Written out by
 * hand in each test, the other twenty lines are noise that hides which field the test is
 * actually about, and they drift: two suites end up with subtly different notions of what an
 * ordinary report looks like.
 *
 * Exported from `testing/` like the other fakes, so the comparison, the summary and anything
 * later that reads reports all build them the same way. It deliberately builds *valid*
 * reports: the defaults satisfy `BenchReportSchema`, so a test that overrides nothing is
 * starting from something the schema would accept.
 */

import { DEFAULT_CATEGORY_WEIGHTS } from "../category.ts";
import type { BenchReport } from "../report.ts";
import { UNRECORDED_CONFIGURATION } from "../run-configuration.ts";
import { VISUAL_NOT_RUN } from "../visual.ts";

/** A passing run of one task that scored 100 and did almost nothing. */
export function benchReport(overrides: Partial<BenchReport> = {}): BenchReport {
  return {
    runId: crypto.randomUUID(),
    taskId: "todo-crud",
    sessionId: crypto.randomUUID(),
    turnId: crypto.randomUUID(),
    status: "passed",
    errorKind: null,
    gates: [],
    scoreCap: null,
    score: 100,
    categories: [],
    weights: DEFAULT_CATEGORY_WEIGHTS,
    // Spread, not the constant itself. Every fake report would otherwise share one
    // configuration object, so a test that reached in and changed a budget would silently
    // change it for every other report built in the same run — which is the same trap the
    // schema's default is a getter to avoid.
    configuration: { ...UNRECORDED_CONFIGURATION },
    checks: [],
    metrics: {
      toolCalls: 0,
      toolFailures: 0,
      commands: 0,
      filesChanged: 0,
      turns: { started: 1, completed: 1, failed: 0, cancelled: 0 },
    },
    screenshots: [],
    visual: VISUAL_NOT_RUN,
    ...overrides,
  };
}

/**
 * One check result, defaulting to a passing command check in the functional category.
 *
 * Separate from the report because the interesting tests supply several of these and nothing
 * else, and repeating `kind`, `weight`, `required` and `build` around each one buries the
 * outcome that the test is about.
 */
export function benchCheck(
  overrides: Partial<BenchReport["checks"][number]> & { checkId: string },
): BenchReport["checks"][number] {
  return {
    kind: "command",
    category: "functional",
    weight: 1,
    required: false,
    build: false,
    outcome: "passed",
    detail: "exit 0",
    ...overrides,
  };
}
