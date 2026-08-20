import { describe, expect, it } from "vitest";
import { hashCollisions, INT4_SPACE, pollCost } from "./probes.ts";

describe("hashCollisions", () => {
  it("reports no collisions when every hash is distinct", () => {
    const report = hashCollisions([1, 2, 3, 4]);
    expect(report).toMatchObject({ ids: 4, distinctHashes: 4, collidingIds: 0, largestGroup: 1 });
  });

  it("counts the ids sharing a hash, not the groups", () => {
    // Three sessions on one lock is three sessions serialized, which is what contention costs.
    const report = hashCollisions([7, 7, 7, 9]);
    expect(report.collidingIds).toBe(3);
    expect(report.largestGroup).toBe(3);
    expect(report.distinctHashes).toBe(2);
  });

  it("states how many collisions chance alone would have produced", () => {
    // The birthday expectation, C(n,2)/space: the measurement is only readable against it.
    const report = hashCollisions([1, 2, 3], 4);
    expect(report.expectedCollidingPairs).toBeCloseTo(3 / 4, 10);
  });

  it("defaults its space to int4, which is what hashtext maps into", () => {
    expect(INT4_SPACE).toBe(2 ** 32);
    const report = hashCollisions(Array.from({ length: 100 }, (_, i) => i));
    expect(report.expectedCollidingPairs).toBeCloseTo((100 * 99) / 2 / 2 ** 32, 12);
  });

  it("has nothing to say about no ids at all", () => {
    expect(hashCollisions([])).toMatchObject({ ids: 0, collidingIds: 0, largestGroup: 0 });
  });
});

describe("pollCost", () => {
  it("turns a tick into a query rate and the share of one connection it burns", () => {
    // 100 sessions polled independently every 2s is 50 queries a second.
    const cost = pollCost({ queriesPerTick: 100, tickIntervalMs: 2_000, perQueryMs: 1.2 });
    expect(cost.queriesPerSecond).toBe(50);
    expect(cost.busyFraction).toBeCloseTo(0.06, 10);
  });

  it("scales the batched case down by exactly the batching factor", () => {
    const perSession = pollCost({ queriesPerTick: 100, tickIntervalMs: 2_000, perQueryMs: 1 });
    const batched = pollCost({ queriesPerTick: 1, tickIntervalMs: 2_000, perQueryMs: 4 });
    expect(perSession.queriesPerSecond / batched.queriesPerSecond).toBe(100);
    expect(perSession.busyFraction / batched.busyFraction).toBe(25);
  });

  it("refuses a tick of zero rather than reporting an infinite rate", () => {
    expect(() => pollCost({ queriesPerTick: 1, tickIntervalMs: 0, perQueryMs: 1 })).toThrow(
      RangeError,
    );
  });
});
