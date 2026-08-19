import { describe, expect, it } from "vitest";
import { CALIBRATION, sampleRange, seededRandom } from "./calibration.ts";

describe("CALIBRATION", () => {
  it("carries the figures the recorded run actually reported", () => {
    expect(CALIBRATION.sandboxCreateMs).toBe(3_074);
    expect(CALIBRATION.previewRenderMs).toBe(2_400);
    expect(CALIBRATION.turnMs).toEqual({ min: 8_000, max: 43_000 });
  });
});

describe("seededRandom", () => {
  it("gives the same stream twice for one seed, so a run is reproducible", () => {
    const first = seededRandom(7);
    const second = seededRandom(7);

    expect([first(), first(), first()]).toEqual([second(), second(), second()]);
  });

  it("gives different streams for different seeds, so users are not in lockstep", () => {
    expect(seededRandom(1)()).not.toBe(seededRandom(2)());
  });

  it("stays inside [0, 1)", () => {
    const random = seededRandom(42);
    for (let i = 0; i < 1_000; i += 1) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});

describe("sampleRange", () => {
  it("lands on the bottom of the range for a zero draw and the top for one just under one", () => {
    expect(sampleRange({ min: 100, max: 200 }, () => 0)).toBe(100);
    expect(sampleRange({ min: 100, max: 200 }, () => 0.999999)).toBeCloseTo(200, 3);
  });

  it("stays within the range over the whole seeded stream", () => {
    const random = seededRandom(3);
    for (let i = 0; i < 1_000; i += 1) {
      const value = sampleRange(CALIBRATION.turnMs, random);
      expect(value).toBeGreaterThanOrEqual(CALIBRATION.turnMs.min);
      expect(value).toBeLessThanOrEqual(CALIBRATION.turnMs.max);
    }
  });

  it("reads a range with no width as its one value", () => {
    expect(sampleRange({ min: 5, max: 5 }, () => 0.5)).toBe(5);
  });
});
