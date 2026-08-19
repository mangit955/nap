import { describe, expect, it } from "vitest";
import { Metrics } from "./metrics.ts";

describe("Metrics", () => {
  it("rolls a trend up into its distribution", () => {
    const metrics = new Metrics();
    for (const value of [10, 20, 30]) metrics.trend("queue_wait", value);

    expect(metrics.rollup().trends.queue_wait).toEqual({
      count: 3,
      min: 10,
      max: 30,
      mean: 20,
      p50: 20,
      p95: 30,
      p99: 30,
    });
  });

  it("counts, defaulting to one at a time", () => {
    const metrics = new Metrics();
    metrics.count("event_seq_gaps");
    metrics.count("event_seq_gaps", 4);

    expect(metrics.rollup().counters.event_seq_gaps).toBe(5);
  });

  it("keeps a rate's numerator and denominator, not just the quotient", () => {
    const metrics = new Metrics();
    metrics.rate("turn_completion_rate", true);
    metrics.rate("turn_completion_rate", true);
    metrics.rate("turn_completion_rate", false);

    expect(metrics.rollup().rates.turn_completion_rate).toEqual({
      passed: 2,
      total: 3,
      rate: 2 / 3,
    });
  });

  it("names a counter that was declared but never incremented, so a zero is visible", () => {
    const metrics = new Metrics();
    metrics.declareCounter("ws_connect_failures");

    expect(metrics.rollup().counters.ws_connect_failures).toBe(0);
  });

  it("rolls up empty when nothing was recorded", () => {
    expect(new Metrics().rollup()).toEqual({ trends: {}, counters: {}, rates: {} });
  });

  it("keeps concurrent recorders apart", () => {
    const one = new Metrics();
    const two = new Metrics();
    one.count("errors");

    expect(two.rollup().counters).toEqual({});
  });
});
