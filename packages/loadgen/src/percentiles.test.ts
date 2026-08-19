import { describe, expect, it } from "vitest";
import { percentile, summarize } from "./percentiles.ts";

describe("percentile", () => {
  it("is the value at the nearest rank, counting from one", () => {
    const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];

    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(100);
    expect(percentile(values, 100)).toBe(100);
  });

  it("does not need its input sorted, and does not reorder it", () => {
    const values = [30, 10, 20];

    expect(percentile(values, 50)).toBe(20);
    expect(values).toEqual([30, 10, 20]);
  });

  it("reads a single sample as every percentile of itself", () => {
    expect(percentile([7], 50)).toBe(7);
    expect(percentile([7], 99)).toBe(7);
  });

  it("rounds the rank up, so p99 of a hundred samples is the worst one", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);

    expect(percentile(values, 99)).toBe(99);
    expect(percentile(values, 99.5)).toBe(100);
  });

  it("refuses an empty sample rather than inventing a number", () => {
    expect(() => percentile([], 95)).toThrow(/no samples/);
  });

  it("refuses a percentile outside (0, 100]", () => {
    expect(() => percentile([1], 0)).toThrow(/between/);
    expect(() => percentile([1], 101)).toThrow(/between/);
  });
});

describe("summarize", () => {
  it("reports nothing for a metric nobody recorded", () => {
    expect(summarize([])).toBeNull();
  });

  it("carries the count, the extremes, the mean and the three percentiles", () => {
    const summary = summarize([1, 2, 3, 4]);

    expect(summary).toEqual({ count: 4, min: 1, max: 4, mean: 2.5, p50: 2, p95: 4, p99: 4 });
  });
});
