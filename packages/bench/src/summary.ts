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
 */

import { attributionOf } from "./error-kind.ts";
import type { BenchReport } from "./report.ts";
import { carriesScore, countsInAggregates } from "./status.ts";

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
    passed: completed.filter((report) => report.status === "passed").length,
    failed: completed.filter((report) => report.status === "failed").length,
    errored: errored.length,
    meanScore,
    agentErrors,
    infrastructureErrors,
    agentErrorRate: rate(agentErrors, counted.length),
    infrastructureErrorRate: rate(infrastructureErrors, counted.length),
    comparable: infrastructureErrors === 0,
  };
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
    `  agent errors     ${summary.agentErrors}  (${summary.agentErrorRate.toFixed(1)}%)`,
    `  infrastructure   ${summary.infrastructureErrors}  (${summary.infrastructureErrorRate.toFixed(1)}%)`,
  ];

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
 * One run, explained: never a number without the checks it came from.
 *
 * An errored run prints no score at all rather than a zero, and says whose fault it was —
 * which is the only thing a run without a result has to contribute.
 */
export function formatRunSummary(report: BenchReport): string {
  const headline =
    report.score === null
      ? `${report.taskId} — ${report.status.toUpperCase()} (${report.errorKind}), no score`
      : `${report.taskId} — ${report.status.toUpperCase()} ${report.score}/100` +
        (report.scoreCap === null ? "" : ` (capped at ${report.scoreCap})`);

  const lines = [headline];

  for (const category of report.categories) {
    lines.push(
      `  ${category.category.padEnd(12, " ")}${String(category.score).padStart(3, " ")}` +
        `  weight ${category.effectiveWeight.toFixed(1)}%, ${category.checks} check` +
        `${category.checks === 1 ? "" : "s"}`,
    );
  }

  // Only the checks that did not pass are listed. A passing check is already accounted for by
  // the category score above it; a failing one is what somebody is about to go and look at.
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
      ` · duration ${metrics.turnDurationMs === undefined ? "—" : `${(metrics.turnDurationMs / 1000).toFixed(1)}s`}` +
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
