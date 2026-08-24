import { describe, expect, it } from "vitest";
import { parseK6Summary, rollupOf, splitMetricName, stageRollups } from "./k6-summary.ts";

/** The shape k6 hands `handleSummary`, trimmed to the fields this repo reads. */
function summary(metrics: Record<string, unknown>) {
  return { metrics, root_group: { name: "" } };
}

describe("splitMetricName", () => {
  it("reads a plain metric as itself with no tags", () => {
    expect(splitMetricName("event_seq_gaps")).toEqual({ name: "event_seq_gaps", tags: {} });
  });

  it("reads a sub-metric's tags", () => {
    expect(splitMetricName("http_req_duration{stage:100,name:submit_turn}")).toEqual({
      name: "http_req_duration",
      tags: { stage: "100", name: "submit_turn" },
    });
  });

  it("keeps a tag value containing a colon whole", () => {
    expect(splitMetricName("x{url:http://localhost:3100}")).toEqual({
      name: "x",
      tags: { url: "http://localhost:3100" },
    });
  });
});

describe("parseK6Summary", () => {
  it("refuses a summary that is not k6's shape", () => {
    expect(parseK6Summary({ metrics: { a: { type: "trend" } } }).ok).toBe(false);
  });

  it("accepts the three metric kinds", () => {
    const parsed = parseK6Summary(
      summary({
        turn_duration: {
          type: "trend",
          values: { avg: 12, min: 8, med: 11, "p(95)": 40, "p(99)": 42, max: 43, count: 5 },
        },
        event_seq_gaps: { type: "counter", values: { count: 0, rate: 0 } },
        turn_completion_rate: { type: "rate", values: { rate: 0.99, passes: 99, fails: 1 } },
      }),
    );
    expect(parsed.ok).toBe(true);
  });
});

describe("rollupOf", () => {
  const parsed = parseK6Summary(
    summary({
      turn_duration: {
        type: "trend",
        values: { avg: 12, min: 8, med: 11, "p(95)": 40, "p(99)": 42, max: 43, count: 5 },
      },
      "turn_duration{stage:100}": {
        type: "trend",
        values: { avg: 30, min: 9, med: 28, "p(95)": 90, "p(99)": 99, max: 120, count: 3 },
      },
      event_seq_gaps: { type: "counter", values: { count: 2, rate: 0.1 } },
      turn_completion_rate: { type: "rate", values: { rate: 0.75, passes: 3, fails: 1 } },
    }),
  );
  if (!parsed.ok) throw new Error("fixture did not parse");

  it("maps k6's statistics onto the rollup a report is read through", () => {
    const rollup = rollupOf(parsed.value);
    expect(rollup.trends.turn_duration).toEqual({
      count: 5,
      min: 8,
      max: 43,
      mean: 12,
      p50: 11,
      p95: 40,
      p99: 42,
    });
    expect(rollup.counters.event_seq_gaps).toBe(2);
    expect(rollup.rates.turn_completion_rate).toEqual({ passed: 3, total: 4, rate: 0.75 });
  });

  it("leaves the tagged sub-metrics out of the untagged rollup", () => {
    // Otherwise one stage's slice would be counted a second time as if it were the whole run.
    expect(Object.keys(rollupOf(parsed.value).trends)).toEqual(["turn_duration"]);
  });
});

describe("stageRollups", () => {
  const parsed = parseK6Summary(
    summary({
      "turn_duration{stage:10}": {
        type: "trend",
        values: { avg: 10, min: 8, med: 10, "p(95)": 12, "p(99)": 13, max: 14, count: 4 },
      },
      "turn_duration{stage:100}": {
        type: "trend",
        values: { avg: 40, min: 9, med: 38, "p(95)": 90, "p(99)": 99, max: 120, count: 40 },
      },
      "event_seq_gaps{stage:100}": { type: "counter", values: { count: 1, rate: 0 } },
      turn_duration: {
        type: "trend",
        values: { avg: 1, min: 1, med: 1, "p(95)": 1, "p(99)": 1, max: 1, count: 1 },
      },
    }),
  );
  if (!parsed.ok) throw new Error("fixture did not parse");

  it("groups the sub-metrics by their stage, ascending", () => {
    const stages = stageRollups(parsed.value, "stage");
    expect(stages.map((stage) => stage.label)).toEqual(["10", "100"]);
    // Numeric, not lexicographic: "100" sorts before "25" as a string, and a degradation
    // report read in that order names the wrong stage as first.
    expect(stages.map((stage) => stage.vus)).toEqual([10, 100]);
    expect(stages[1]?.metrics.trends.turn_duration?.p95).toBe(90);
    expect(stages[1]?.metrics.counters.event_seq_gaps).toBe(1);
  });

  it("sorts numerically", () => {
    const many = parseK6Summary(
      summary({
        "x{stage:100}": { type: "counter", values: { count: 1, rate: 0 } },
        "x{stage:25}": { type: "counter", values: { count: 1, rate: 0 } },
        "x{stage:9}": { type: "counter", values: { count: 1, rate: 0 } },
      }),
    );
    if (!many.ok) throw new Error("fixture did not parse");
    expect(stageRollups(many.value, "stage").map((stage) => stage.vus)).toEqual([9, 25, 100]);
  });
});
