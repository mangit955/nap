import { describe, expect, it } from "vitest";
import { Field, type Shape, sdCapsule, sdRoundBox, shapeSD, smin } from "./sdf.ts";

const box = (over: Partial<Extract<Shape, { kind: "box" }>> = {}): Shape => ({
  kind: "box",
  cx: 0,
  cy: 0,
  hw: 50,
  hh: 30,
  r: 8,
  ...over,
});

describe("a rounded box's distance", () => {
  it("is negative inside, zero on the face and positive outside", () => {
    // The sign convention is what every other file here reads; if it flipped, the outline would
    // trace the space around the cards rather than the cards.
    expect(sdRoundBox(0, 0, 0, 0, 50, 30, 8)).toBeLessThan(0);
    expect(sdRoundBox(50, 0, 0, 0, 50, 30, 8)).toBeCloseTo(0, 6);
    expect(sdRoundBox(70, 0, 0, 0, 50, 30, 8)).toBeCloseTo(20, 6);
  });

  it("measures the true diagonal distance past a corner, not the larger axis", () => {
    // The naive version returns max(qx, qy) and is wrong by 41% at 45°, which reads as a squared
    // corner on the fused skin exactly where the fillet should be.
    expect(sdRoundBox(53, 33, 0, 0, 50, 30, 0)).toBeCloseTo(Math.hypot(3, 3), 6);
  });

  it("clamps a radius larger than the box rather than inverting it", () => {
    expect(sdRoundBox(0, 0, 0, 0, 10, 10, 999)).toBeCloseTo(-10, 6);
  });
});

describe("a capsule's distance", () => {
  it("is the distance to the segment, less the radius", () => {
    expect(sdCapsule(0, 10, -20, 0, 20, 0, 4)).toBeCloseTo(6, 6);
  });

  it("clamps to the ends rather than to the infinite line", () => {
    // Past the end, the nearest point is the cap's centre — a line would answer 4 here.
    expect(sdCapsule(30, 0, -20, 0, 20, 0, 4)).toBeCloseTo(6, 6);
  });

  it("treats a zero-length segment as a circle instead of dividing by zero", () => {
    expect(sdCapsule(0, 5, 0, 0, 0, 0, 2)).toBeCloseTo(3, 6);
  });
});

describe("the smooth minimum", () => {
  it("is exactly min when there is no blend", () => {
    expect(smin(3, 8, 0)).toBe(3);
    expect(smin(-2, 5, 0)).toBe(-2);
  });

  it("dips below both inputs near the seam, which is the fillet", () => {
    // Not "rounds off the crease": the result has to go *under* both fields, because that is what
    // pushes the zero contour outward into a concave joint.
    const blended = smin(4, 4, 10);
    expect(blended).toBeLessThan(4);
  });

  it("leaves a field alone far from the seam", () => {
    expect(smin(-100, 40, 10)).toBeCloseTo(-100, 6);
  });

  it("blends further as k grows", () => {
    expect(smin(4, 4, 20)).toBeLessThan(smin(4, 4, 5));
  });
});

describe("a field of several shapes", () => {
  it("is the shape's own distance when it holds one", () => {
    const shape = box();
    const field = new Field([shape], 20);

    expect(field.eval(12, 7)).toBeCloseTo(shapeSD(shape, 12, 7), 6);
  });

  it("reads as inside between two boxes that a hard union would leave a gap between", () => {
    // The point sits outside both boxes; the blend is the only thing that can enclose it, and
    // enclosing it is the whole visual claim of this directory.
    const left = box({ cx: -55 });
    const right = box({ cx: 55 });
    const gap = { x: 0, y: 0 };

    expect(shapeSD(left, gap.x, gap.y)).toBeGreaterThan(0);
    expect(shapeSD(right, gap.x, gap.y)).toBeGreaterThan(0);
    expect(new Field([left, right], 0).eval(gap.x, gap.y)).toBeGreaterThan(0);
    expect(new Field([left, right], 30).eval(gap.x, gap.y)).toBeLessThan(0);
  });

  it("is nowhere when it is empty", () => {
    expect(new Field([], 10).eval(0, 0)).toBe(Number.POSITIVE_INFINITY);
    expect(new Field([], 10).bounds()).toEqual({ minX: 0, minY: 0, maxX: 0, maxY: 0 });
  });
});

describe("a field's bounds", () => {
  it("pad by the blend, because the skin bulges outside every card", () => {
    // Sized to the cards themselves, the sample grid would cut the fillets off square.
    const bounds = new Field([box()], 12).bounds();

    expect(bounds.minX).toBeCloseTo(-62, 6);
    expect(bounds.maxY).toBeCloseTo(42, 6);
  });

  it("cover a bridge's caps as well as its ends", () => {
    const bounds = new Field([{ kind: "bridge", ax: 0, ay: 0, bx: 100, by: 0, r: 6 }], 0).bounds();

    expect(bounds.minX).toBeCloseTo(-6, 6);
    expect(bounds.maxX).toBeCloseTo(106, 6);
  });
});
