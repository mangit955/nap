import { describe, expect, it } from "vitest";
import { recommendWorkerConcurrency } from "./worker-concurrency.ts";

describe("recommendWorkerConcurrency", () => {
  it("applies Little's law: in-flight work is arrival rate times how long each takes", () => {
    // 4 turns a second, 25 seconds each — a hundred turns are in flight at any moment.
    const advice = recommendWorkerConcurrency({
      turnsPerSecond: 4,
      meanTurnMs: 25_000,
      workers: 1,
      headroom: 1,
    });
    expect(advice.inFlight).toBe(100);
    expect(advice.perWorker).toBe(100);
  });

  it("divides the work across the workers that will share it, rounding up", () => {
    const advice = recommendWorkerConcurrency({
      turnsPerSecond: 4,
      meanTurnMs: 25_000,
      workers: 3,
      headroom: 1,
    });
    expect(advice.perWorker).toBe(34);
  });

  it("carries headroom, because a queue at exactly its arrival rate never drains", () => {
    const advice = recommendWorkerConcurrency({
      turnsPerSecond: 4,
      meanTurnMs: 25_000,
      workers: 2,
      headroom: 1.5,
    });
    expect(advice.inFlight).toBe(100);
    expect(advice.perWorker).toBe(75);
  });

  it("never recommends zero, however light the load measured", () => {
    const advice = recommendWorkerConcurrency({
      turnsPerSecond: 0.001,
      meanTurnMs: 10,
      workers: 4,
    });
    expect(advice.perWorker).toBe(1);
  });

  it("refuses arithmetic it cannot do", () => {
    expect(() =>
      recommendWorkerConcurrency({ turnsPerSecond: 1, meanTurnMs: 1_000, workers: 0 }),
    ).toThrow(RangeError);
    expect(() =>
      recommendWorkerConcurrency({ turnsPerSecond: -1, meanTurnMs: 1_000, workers: 1 }),
    ).toThrow(RangeError);
  });
});
