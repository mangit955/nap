/**
 * What a person reads at the end: one run explained, and a suite characterised.
 *
 * Pure functions from reports to strings and to one aggregate value, so the arithmetic that
 * decides whether a suite's numbers may be quoted is tested rather than printed hopefully.
 * The report on disk stays the machine-readable record; this is the part somebody actually
 * looks at, and it exists so that reading a result does not mean opening JSON.
 *
 * **The aggregation is where the error kinds pay off.** The mean is over completed runs only —
 * a run with no score cannot be averaged in as a zero without charging an outage to the model
 * — and the two error rates are kept apart, because a suite contaminated by infrastructure is
 * not weak data but *not data*. See docs/adr/0002.
 *
 * **A mean alone is still an anecdote**, so a suite that repeated anything reports each task's
 * spread beside it, and a success rate beside the mean: 85 every time and 100/70 alternating
 * are the same average and are not the same thing to depend on. The spread is per task, never
 * across the suite — see `distribution.ts` for why that distinction is the whole point.
 */

import { type Distribution, describeDistribution } from "./distribution.ts";
import { attributionOf } from "./error-kind.ts";
import { PRODUCT_DIMENSIONS } from "./product/dimension.ts";
import type { BenchReport } from "./report.ts";
import { carriesScore, countsInAggregates } from "./status.ts";

/**
 * One task's runs, gathered — which is the level a spread means anything at.
 *
 * Present even when every task ran once, so that the shape of the summary does not depend on
 * how it was invoked and nothing downstream has to branch on whether repeats were asked for.
 */
export type TaskRuns = {
  taskId: string;
  /** Everything attempted for this task, cancellations included. */
  runs: number;
  /** Runs that produced no result. Kept beside the scores, which cannot represent them. */
  errored: number;
  /** Over this task's completed runs only. */
  scores: Distribution;
};

export type SuiteSummary = {
  /** A suite name, or the task id when one task was run. */
  name: string;
  /** Every run attempted, cancellations included. */
  runs: number;
  /**
   * Runs a suite may count, in a numerator or a denominator: everything but the cancelled.
   *
   * The denominator of both rates. Cancelled runs are excluded in both directions, so that
   * whoever ran the suite cannot move its numbers by pressing stop.
   */
  counted: number;
  cancelled: number;
  /** Runs that produced a score, which are the only ones the mean is over. */
  completed: number;
  passed: number;
  failed: number;
  errored: number;
  /** Over completed runs, to one decimal place. Null when nothing produced a score. */
  meanScore: number | null;
  agentErrors: number;
  infrastructureErrors: number;
  /** Percentages of counted runs, to one decimal place. Zero when nothing was counted. */
  agentErrorRate: number;
  infrastructureErrorRate: number;
  /**
   * The share of counted runs that passed outright.
   *
   * Reported beside the mean because they answer different questions and can disagree loudly: a
   * configuration that scores 85 every time and one that alternates 100 and 70 have the same
   * mean and are not the same thing to depend on.
   */
  successRate: number;
  /**
   * Each task's own runs and spread, in the order the tasks were first seen.
   *
   * Per task rather than one figure over the suite, because a spread across *different* tasks
   * measures how much the tasks differ in difficulty — a fact about the benchmark, not about
   * the model. Ordered by first appearance rather than by score so that two runs of the same
   * suite can be read side by side.
   */
  tasks: TaskRuns[];
  /**
   * Whether this suite's mean may be compared with another's.
   *
   * False as soon as one run errored on something that is not the agent. Deliberately strict:
   * the alternative is a threshold, and a threshold is a number somebody argues with a week
   * later when the result is inconvenient.
   */
  comparable: boolean;
};

export function summariseSuite(name: string, reports: readonly BenchReport[]): SuiteSummary {
  const counted = reports.filter((report) => countsInAggregates(report.status));
  const completed = counted.filter((report) => carriesScore(report.status));

  const scores = completed.map((report) => report.score ?? 0);
  const meanScore =
    scores.length === 0
      ? null
      : round1(scores.reduce((total, score) => total + score, 0) / scores.length);

  const passed = completed.filter((report) => report.status === "passed").length;
  const errored = counted.filter((report) => report.errorKind !== null);
  const agentErrors = errored.filter(
    (report) => report.errorKind !== null && attributionOf(report.errorKind) === "agent",
  ).length;
  const infrastructureErrors = errored.length - agentErrors;

  return {
    name,
    runs: reports.length,
    counted: counted.length,
    cancelled: reports.length - counted.length,
    completed: completed.length,
    passed,
    failed: completed.filter((report) => report.status === "failed").length,
    errored: errored.length,
    meanScore,
    agentErrors,
    infrastructureErrors,
    agentErrorRate: rate(agentErrors, counted.length),
    infrastructureErrorRate: rate(infrastructureErrors, counted.length),
    successRate: rate(
      completed.filter((report) => report.status === "passed").length,
      counted.length,
    ),
    tasks: groupByTask(reports),
    comparable: infrastructureErrors === 0,
  };
}

/**
 * Every task's runs, in the order the tasks were first attempted.
 *
 * A `Map` because insertion order is exactly the order wanted and getting it from a sort would
 * mean inventing a key to sort on — the suite's declared order is not visible from a list of
 * reports, but the order they were run in is.
 */
function groupByTask(reports: readonly BenchReport[]): TaskRuns[] {
  const byTask = new Map<string, BenchReport[]>();
  for (const report of reports) {
    const existing = byTask.get(report.taskId);
    if (existing === undefined) byTask.set(report.taskId, [report]);
    else existing.push(report);
  }

  return [...byTask].map(([taskId, runs]) => {
    const counted = runs.filter((report) => countsInAggregates(report.status));

    return {
      taskId,
      runs: runs.length,
      errored: counted.filter((report) => report.errorKind !== null).length,
      scores: describeDistribution(
        counted.filter((report) => carriesScore(report.status)).map((report) => report.score ?? 0),
      ),
    };
  });
}

/**
 * The suite as a person reads it, with the warning that matters put where it cannot be missed.
 *
 * The banner is the whole reason this is a function rather than a `console.log`: a non-zero
 * infrastructure rate has to be the loudest thing on the screen, because the failure mode it
 * guards against is somebody quoting a mean from a contaminated suite a week later.
 */
export function formatSuiteSummary(summary: SuiteSummary): string {
  const lines = [
    "",
    `${summary.name} — ${summary.runs} run${summary.runs === 1 ? "" : "s"}: ` +
      `${summary.passed} passed, ${summary.failed} failed, ` +
      `${summary.errored} errored, ${summary.cancelled} cancelled`,
    `  mean score       ${summary.meanScore === null ? "—" : summary.meanScore.toFixed(1)}` +
      `  (over ${summary.completed} of ${summary.counted} counted runs)`,
    `  success rate     ${summary.successRate.toFixed(1)}%  (${summary.passed} of ${summary.counted} counted runs passed)`,
    `  agent errors     ${summary.agentErrors}  (${summary.agentErrorRate.toFixed(1)}%)`,
    `  infrastructure   ${summary.infrastructureErrors}  (${summary.infrastructureErrorRate.toFixed(1)}%)`,
  ];

  lines.push(...spreadLines(summary.tasks));

  if (!summary.comparable) {
    lines.push(
      "",
      `!! ${summary.infrastructureErrors} of ${summary.counted} runs errored on infrastructure ` +
        `(${summary.infrastructureErrorRate.toFixed(1)}%).`,
      "!! THIS SUITE IS NOT COMPARABLE DATA — the failures say nothing about the model.",
      "!! Fix the infrastructure and run it again before quoting any number above.",
      "",
    );
  }

  if (summary.cancelled > 0) {
    lines.push(
      `${summary.cancelled} cancelled run${summary.cancelled === 1 ? " is" : "s are"} excluded ` +
        "from the mean and from both rates.",
    );
  }

  return lines.join("\n");
}

/**
 * Each task's spread, printed only when something was actually run more than once.
 *
 * Silent otherwise, and deliberately: a "distribution" of one score per task is a second copy
 * of the per-run summaries the reader has just scrolled past, wearing the clothes of
 * statistics. The point of this section is variance, and one run has none to show.
 *
 * The extremes are printed beside the average because they are what a reader reaches for the
 * moment the spread turns out to be wide — the question after "the deviation is 8.7" is always
 * "how bad was the worst one".
 */
function spreadLines(tasks: readonly TaskRuns[]): string[] {
  const repeated = tasks.filter((task) => task.runs > 1);
  if (repeated.length === 0) return [];

  const lines = ["", "  spread, per task, over the runs that scored:"];

  for (const task of repeated) {
    const { scores } = task;
    if (scores.mean === null || scores.median === null) {
      lines.push(`    ${task.taskId.padEnd(18, " ")}no run scored (${task.runs} attempted)`);
      continue;
    }

    lines.push(
      `    ${task.taskId.padEnd(18, " ")}` +
        `mean ${scores.mean.toFixed(1)}  median ${scores.median.toFixed(1)}  ` +
        // Null for a single scoring run, and printed as a dash rather than as 0.0: zero would
        // read as perfect consistency when nothing was measured twice.
        `sd ${scores.stdDev === null ? "—" : scores.stdDev.toFixed(1)}  ` +
        `range ${scores.lowest}–${scores.highest}  ` +
        `(${scores.n} of ${task.runs}${task.errored === 0 ? "" : `, ${task.errored} errored`})`,
    );
  }

  return lines;
}

/**
 * One run, explained: never a number without the checks it came from.
 *
 * An errored run prints no score at all rather than a zero, and says whose fault it was —
 * which is the only thing a run without a result has to contribute.
 */
export function formatRunSummary(report: BenchReport): string {
  const headline = `${report.taskId} — ${report.status.toUpperCase()}${
    report.errorKind === null ? "" : ` (${report.errorKind})`
  } ${
    // Cancellation carries no kind and is not an error, so it prints neither — per ADR-0002,
    // a run somebody stopped is not an observation about anything and must not read as one.
    report.score === null
      ? "no score"
      : `${report.score}/100${report.scoreCap === null ? "" : ` (capped at ${report.scoreCap})`}`
  }`;

  const lines = [headline];

  for (const category of report.categories) {
    lines.push(
      `  ${category.category.padEnd(12, " ")}${String(category.score).padStart(3, " ")}` +
        `  weight ${category.effectiveWeight.toFixed(1)}%, ${category.checks} check` +
        `${category.checks === 1 ? "" : "s"}`,
    );
  }

  lines.push(...productLines(report));

  // The tally first, then the checks that did not pass. Together they close the arithmetic: a
  // reader can see how many checks each category score was over, and read the name of every one
  // that did not pass — so no number here is handed over unexplained.
  if (report.checks.length > 0) {
    const passed = report.checks.filter((check) => check.outcome === "passed").length;
    const failed = report.checks.filter((check) => check.outcome === "failed").length;
    const absent = report.checks.length - passed - failed;
    lines.push(
      `  checks: ${passed} passed, ${failed} failed${absent === 0 ? "" : `, ${absent} absent`}`,
    );
  }

  for (const check of report.checks) {
    if (check.outcome === "passed") continue;
    lines.push(`  ${check.outcome === "failed" ? "✗" : "·"} ${check.checkId} — ${check.detail}`);
  }

  if (report.gates.length > 0) lines.push(`  gates: ${report.gates.join(", ")}`);

  const metrics = report.metrics;
  lines.push(
    `  turns ${metrics.turns.completed}/${metrics.turns.started}` +
      ` · tools ${metrics.toolCalls} (${metrics.toolFailures} failed)` +
      ` · commands ${metrics.commands} · files ${metrics.filesChanged}` +
      // Named for the turns, because that is what it measures: the sandbox's startup, the
      // preview probe and the checks all happen outside it, and calling it the run's duration
      // would overstate what the log can actually answer. See `metrics.ts`.
      ` · turn time ${metrics.turnDurationMs === undefined ? "—" : `${(metrics.turnDurationMs / 1000).toFixed(1)}s`}` +
      ` · tokens ${
        metrics.tokens === undefined
          ? "—"
          : `${count(metrics.tokens.inputTokens)} in / ${count(metrics.tokens.outputTokens)} out`
      }`,
  );

  if (metrics.estimatedCost !== undefined) {
    // Labelled an estimate everywhere it appears, because it is derived from a price table
    // rather than measured, and a number that looks like a bill will be read as one.
    lines.push(`  estimated cost ~$${metrics.estimatedCost.usd.toFixed(4)} (estimate)`);
  }

  if (report.screenshots.length > 0) {
    lines.push(`  ${report.screenshots.length} screenshot(s) beside the report`);
  }

  return lines.join("\n");
}

/**
 * The two halves, and every dimension that was graded — printed only for a run that was judged.
 *
 * Nothing for a v1 run, rather than a row of dashes: those runs were not scored this way, and a
 * summary that implied they had been would be the same mistake `compare` refuses across models.
 *
 * The judge's name is printed beside the number because a product score is the one figure in a
 * report that depends on *who* produced it, and the commonest reading of one will be a free run's
 * scripted grades — which mean nothing about any application.
 */
function productLines(report: BenchReport): string[] {
  const halves = report.halves;
  if (halves === null) return [];

  const lines = [
    `  halves: objective ${halves.objective}` +
      (halves.product === null
        ? " · product not judged, so the objective half stands alone"
        : ` × product ${halves.product}, combined geometrically`),
  ];

  if (report.product?.status === "judged") {
    const judged = report.product;
    lines.push(`  judged by ${judged.judge.source} (rubric ${judged.judge.rubricVersion})`);

    const grades = PRODUCT_DIMENSIONS.map((dimension) => {
      const answer = judged.dimensions[dimension];
      return `${dimension} ${answer.status === "graded" ? answer.grade : "—"}`;
    });
    lines.push(`  ${grades.join(", ")}`);

    // The holistic read, kept beside the nine and outside them: its value is the disagreement
    // with the computed mean, which is only visible if a reader can see both.
    if (judged.polish.status === "graded") {
      lines.push(`  polish ${judged.polish.grade} (reported, never scored)`);
    }
  }

  return lines;
}

/** Grouped, because six-figure token counts are read wrong often enough to matter. */
function count(value: number): string {
  return value.toLocaleString("en-US");
}

function rate(part: number, whole: number): number {
  return whole === 0 ? 0 : round1((part / whole) * 100);
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
