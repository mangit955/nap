import { describe, expect, it } from "vitest";
import { type DegradationRule, firstDegradation, type StageObservation } from "./degradation.ts";
import type { MetricsRollup } from "./metrics.ts";

function trend(p95: number): MetricsRollup["trends"][string] {
  return { count: 10, min: p95, max: p95, mean: p95, p50: p95, p95, p99: p95 };
}

function stage(vus: number, p95: number, extra: Partial<MetricsRollup> = {}): StageObservation {
  return {
    label: String(vus),
    vus,
    metrics: {
      trends: { admission_latency: trend(p95) },
      counters: {},
      rates: {},
      ...extra,
    },
  };
}

const LATENCY: DegradationRule = {
  kind: "trend",
  metric: "admission_latency",
  statistic: "p95",
  multipleOfBaseline: 2,
  floor: 50,
};

describe("firstDegradation", () => {
  it("finds nothing when every stage looks like the first", () => {
    expect(firstDegradation([stage(10, 20), stage(50, 22), stage(100, 25)], [LATENCY])).toBeNull();
  });

  it("names the first stage where a trend multiplies past the baseline", () => {
    const found = firstDegradation([stage(10, 40), stage(50, 90), stage(100, 400)], [LATENCY]);
    expect(found?.vus).toBe(50);
    expect(found?.reasons[0]).toContain("admission_latency");
  });

  it("ignores a multiple that is still fast in absolute terms", () => {
    // 2ms to 8ms is a fourfold rise and nobody can feel it; a floor is what stops a baseline
    // report calling that the point the system broke.
    expect(firstDegradation([stage(10, 2), stage(50, 8), stage(100, 20)], [LATENCY])).toBeNull();
  });

  it("treats a counter above its ceiling as degradation", () => {
    const stages = [
      stage(10, 10),
      stage(50, 10, { counters: { event_seq_gaps: 0 } }),
      stage(100, 10, { counters: { event_seq_gaps: 3 } }),
    ];
    const found = firstDegradation(stages, [
      { kind: "counter", metric: "event_seq_gaps", maxValue: 0 },
    ]);
    expect(found?.vus).toBe(100);
    expect(found?.reasons[0]).toContain("event_seq_gaps");
  });

  it("treats a rate below its floor as degradation", () => {
    const stages = [
      stage(10, 10, { rates: { turn_completion_rate: { passed: 10, total: 10, rate: 1 } } }),
      stage(50, 10, { rates: { turn_completion_rate: { passed: 8, total: 10, rate: 0.8 } } }),
    ];
    const found = firstDegradation(stages, [
      { kind: "rate", metric: "turn_completion_rate", minValue: 0.99 },
    ]);
    expect(found?.vus).toBe(50);
  });

  it("reports every reason the stage failed, not just the first", () => {
    const stages = [
      stage(10, 40, { counters: { errors_5xx: 0 } }),
      stage(50, 500, { counters: { errors_5xx: 7 } }),
    ];
    const found = firstDegradation(stages, [
      LATENCY,
      { kind: "counter", metric: "errors_5xx", maxValue: 0 },
    ]);
    expect(found?.reasons).toHaveLength(2);
  });

  it("never blames the baseline stage itself", () => {
    // The first stage *is* the yardstick, so it cannot be a multiple of itself; a rule that
    // let it degrade would report "the system broke at 10 users" on every run.
    const stages = [stage(10, 5_000), stage(50, 5_000)];
    expect(firstDegradation(stages, [LATENCY])).toBeNull();
  });

  it("has nothing to say about a run with one stage", () => {
    expect(firstDegradation([stage(10, 10)], [LATENCY])).toBeNull();
  });

  it("skips a rule whose metric that stage never recorded", () => {
    // Unlike a threshold, a missing metric here is ordinary: a counter only appears in a
    // stage that touched it, and "absent" is not evidence of degradation.
    expect(
      firstDegradation(
        [stage(10, 10), stage(50, 10)],
        [{ kind: "counter", metric: "never_recorded", maxValue: 0 }],
      ),
    ).toBeNull();
  });
});
