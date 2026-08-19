/**
 * What a run says when it is over.
 *
 * Two things, kept apart on purpose. `evaluateThresholds` decides whether the run passed — a
 * pure function of the rollup and a list of conditions, so the verdict is testable and so the
 * same conditions can be handed to k6 later without being restated in prose. `formatReport`
 * decides what it looks like in a terminal, which is the part nobody should be tempted to
 * assert on.
 *
 * The thresholds themselves are not defined here: which numbers a run is held to is a property
 * of the run (`docs/scaling-design.md` §23 states the headline profile's), not of the maths.
 */

import type { MetricsRollup } from "./metrics.ts";

/** Which number of a metric a threshold is about. */
export type Statistic = "count" | "min" | "max" | "mean" | "p50" | "p95" | "p99" | "rate";

export type Comparison = "<" | "<=" | ">" | ">=" | "==";

export type Threshold = {
  metric: string;
  statistic: Statistic;
  op: Comparison;
  value: number;
};

export type ThresholdResult = Threshold & {
  /** What the run actually produced, or `null` when the metric was never recorded. */
  actual: number | null;
  passed: boolean;
};

export type LoadReport = {
  startedAt: string;
  durationMs: number;
  users: { started: number; completed: number; failed: number };
  metrics: MetricsRollup;
  thresholds: ThresholdResult[];
  /** True only when every user completed and every threshold held. */
  passed: boolean;
};

function compare(actual: number, op: Comparison, value: number): boolean {
  switch (op) {
    case "<":
      return actual < value;
    case "<=":
      return actual <= value;
    case ">":
      return actual > value;
    case ">=":
      return actual >= value;
    case "==":
      return actual === value;
  }
}

/**
 * Reads one statistic out of a rollup, whichever of the three kinds holds it.
 *
 * `null` means the metric is not there. A counter that was never touched is not one of those —
 * `Metrics.declareCounter` exists so the counters that must be zero read as zero rather than as
 * absent, because a threshold silently skipped is the failure mode that matters here.
 */
export function statisticOf(
  rollup: MetricsRollup,
  metric: string,
  statistic: Statistic,
): number | null {
  const counter = rollup.counters[metric];
  if (counter !== undefined) return statistic === "count" ? counter : null;

  const rate = rollup.rates[metric];
  if (rate !== undefined) {
    if (statistic === "rate") return rate.rate;
    return statistic === "count" ? rate.total : null;
  }

  const trend = rollup.trends[metric];
  if (trend === undefined || statistic === "rate") return null;
  return trend[statistic];
}

/**
 * A threshold whose metric was never recorded **fails**.
 *
 * The alternative — treating it as vacuously true — means a harness that silently stopped
 * recording something reports a green run, which is the one outcome a load test must never
 * produce by accident.
 */
export function evaluateThresholds(
  rollup: MetricsRollup,
  thresholds: readonly Threshold[],
): ThresholdResult[] {
  return thresholds.map((threshold) => {
    const actual = statisticOf(rollup, threshold.metric, threshold.statistic);
    return {
      ...threshold,
      actual,
      passed: actual !== null && compare(actual, threshold.op, threshold.value),
    };
  });
}

export type ReportInput = {
  startedAt: Date;
  durationMs: number;
  users: { started: number; completed: number; failed: number };
  metrics: MetricsRollup;
  thresholds: readonly Threshold[];
};

export function buildReport(input: ReportInput): LoadReport {
  const thresholds = evaluateThresholds(input.metrics, input.thresholds);

  return {
    startedAt: input.startedAt.toISOString(),
    durationMs: input.durationMs,
    users: input.users,
    metrics: input.metrics,
    thresholds,
    passed: input.users.failed === 0 && thresholds.every((result) => result.passed),
  };
}

function ms(value: number): string {
  return `${Math.round(value)}ms`;
}

export function formatReport(report: LoadReport): string {
  const lines: string[] = [];

  lines.push(
    `${report.users.completed}/${report.users.started} users completed in ${(report.durationMs / 1000).toFixed(1)}s`,
  );

  const trends = Object.entries(report.metrics.trends);
  if (trends.length > 0) {
    lines.push("", "  metric                     n      p50      p95      p99      max");
    for (const [name, summary] of trends) {
      lines.push(
        `  ${name.padEnd(22)} ${String(summary.count).padStart(5)} ${ms(summary.p50).padStart(8)} ${ms(summary.p95).padStart(8)} ${ms(summary.p99).padStart(8)} ${ms(summary.max).padStart(8)}`,
      );
    }
  }

  const counters = Object.entries(report.metrics.counters);
  if (counters.length > 0) {
    lines.push("");
    for (const [name, value] of counters) lines.push(`  ${name.padEnd(22)} ${value}`);
  }

  const rates = Object.entries(report.metrics.rates);
  if (rates.length > 0) {
    lines.push("");
    for (const [name, rate] of rates) {
      lines.push(
        `  ${name.padEnd(22)} ${(rate.rate * 100).toFixed(1)}%  (${rate.passed}/${rate.total})`,
      );
    }
  }

  if (report.thresholds.length > 0) {
    lines.push("", "  thresholds");
    for (const result of report.thresholds) {
      const actual = result.actual === null ? "never recorded" : String(Math.round(result.actual));
      lines.push(
        `  ${result.passed ? "ok  " : "FAIL"}  ${result.metric}.${result.statistic} ${result.op} ${result.value}  — ${actual}`,
      );
    }
  }

  lines.push("", report.passed ? "PASS" : "FAIL");

  return lines.join("\n");
}
