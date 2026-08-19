import { describe, expect, it } from "vitest";
import { Metrics } from "./metrics.ts";
import { buildReport, evaluateThresholds, formatReport, statisticOf } from "./report.ts";

function rollupOf(fill: (metrics: Metrics) => void) {
  const metrics = new Metrics();
  fill(metrics);
  return metrics.rollup();
}

const ROLLUP = rollupOf((metrics) => {
  for (const value of [100, 200, 300, 400]) metrics.trend("queue_wait", value);
  metrics.declareCounter("event_seq_gaps");
  metrics.count("errors_rate_limited", 3);
  metrics.rate("turn_completion_rate", true);
  metrics.rate("turn_completion_rate", false);
});

describe("statisticOf", () => {
  it("reads a trend's percentiles", () => {
    expect(statisticOf(ROLLUP, "queue_wait", "p50")).toBe(200);
    expect(statisticOf(ROLLUP, "queue_wait", "count")).toBe(4);
  });

  it("reads a counter's count, including one that stayed at zero", () => {
    expect(statisticOf(ROLLUP, "errors_rate_limited", "count")).toBe(3);
    expect(statisticOf(ROLLUP, "event_seq_gaps", "count")).toBe(0);
  });

  it("reads a rate as its quotient, and its count as the denominator", () => {
    expect(statisticOf(ROLLUP, "turn_completion_rate", "rate")).toBe(0.5);
    expect(statisticOf(ROLLUP, "turn_completion_rate", "count")).toBe(2);
  });

  it("has no answer for a statistic the metric's kind does not have", () => {
    expect(statisticOf(ROLLUP, "queue_wait", "rate")).toBeNull();
    expect(statisticOf(ROLLUP, "event_seq_gaps", "p95")).toBeNull();
  });

  it("has no answer for a metric nobody recorded", () => {
    expect(statisticOf(ROLLUP, "nothing_recorded_this", "p95")).toBeNull();
  });
});

describe("evaluateThresholds", () => {
  it("passes and fails on the comparison it was given", () => {
    const results = evaluateThresholds(ROLLUP, [
      { metric: "queue_wait", statistic: "p95", op: "<", value: 5_000 },
      { metric: "queue_wait", statistic: "p95", op: "<", value: 100 },
      { metric: "event_seq_gaps", statistic: "count", op: "==", value: 0 },
      { metric: "turn_completion_rate", statistic: "rate", op: ">", value: 0.99 },
    ]);

    expect(results.map((result) => result.passed)).toEqual([true, false, true, false]);
    expect(results[0]?.actual).toBe(400);
  });

  it("fails a threshold whose metric was never recorded, rather than skipping it", () => {
    const [result] = evaluateThresholds(ROLLUP, [
      { metric: "event_delivery_latency", statistic: "p95", op: "<", value: 1_000 },
    ]);

    expect(result).toMatchObject({ actual: null, passed: false });
  });
});

describe("buildReport", () => {
  const input = {
    startedAt: new Date("2026-08-20T10:00:00.000Z"),
    durationMs: 42_000,
    users: { started: 1, completed: 1, failed: 0 },
    metrics: ROLLUP,
  };

  it("passes only when every threshold held", () => {
    const green = buildReport({
      ...input,
      thresholds: [{ metric: "event_seq_gaps", statistic: "count", op: "==", value: 0 }],
    });
    const red = buildReport({
      ...input,
      thresholds: [{ metric: "queue_wait", statistic: "p95", op: "<", value: 1 }],
    });

    expect(green.passed).toBe(true);
    expect(red.passed).toBe(false);
  });

  it("fails a run whose thresholds all held but whose users did not finish", () => {
    const report = buildReport({
      ...input,
      users: { started: 2, completed: 1, failed: 1 },
      thresholds: [{ metric: "event_seq_gaps", statistic: "count", op: "==", value: 0 }],
    });

    expect(report.passed).toBe(false);
  });

  it("records when it started as an ISO instant", () => {
    expect(buildReport({ ...input, thresholds: [] }).startedAt).toBe("2026-08-20T10:00:00.000Z");
  });
});

describe("formatReport", () => {
  it("names every metric, and says plainly whether the run passed", () => {
    const text = formatReport(
      buildReport({
        startedAt: new Date("2026-08-20T10:00:00.000Z"),
        durationMs: 42_000,
        users: { started: 1, completed: 1, failed: 0 },
        metrics: ROLLUP,
        thresholds: [{ metric: "queue_wait", statistic: "p95", op: "<", value: 1 }],
      }),
    );

    expect(text).toContain("1/1 users completed");
    expect(text).toContain("queue_wait");
    expect(text).toContain("event_seq_gaps");
    expect(text).toContain("turn_completion_rate");
    expect(text).toMatch(/FAIL\s+queue_wait\.p95 < 1/);
    expect(text.trimEnd().endsWith("FAIL")).toBe(true);
  });
});
