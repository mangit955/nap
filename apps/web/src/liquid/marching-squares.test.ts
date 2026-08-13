import { describe, expect, it } from "vitest";
import { contour, fieldToPath } from "./marching-squares.ts";
import { Field, type Shape } from "./sdf.ts";

const box = (cx: number, cy = 0): Shape => ({ kind: "box", cx, cy, hw: 40, hh: 26, r: 10 });

/** The extent of every point in a set of loops, for comparing an outline against its shape. */
function extent(loops: { x: number; y: number }[][]) {
  const xs = loops.flat().map((point) => point.x);
  const ys = loops.flat().map((point) => point.y);
  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys),
    maxY: Math.max(...ys),
  };
}

describe("tracing one box", () => {
  it("finds a single closed outline sitting on the box's face", () => {
    const loops = contour(new Field([box(0)], 0), { cell: 2 });

    expect(loops).toHaveLength(1);
    const { minX, maxX, minY, maxY } = extent(loops);
    // Within a cell of the real face: the crossing is interpolated, so the error is far below the
    // grid step rather than the half-cell a midpoint tracer would leave.
    expect(minX).toBeGreaterThan(-42);
    expect(maxX).toBeLessThan(42);
    expect(minY).toBeGreaterThan(-28);
    expect(maxY).toBeLessThan(28);
  });
});

describe("tracing two boxes", () => {
  it("returns two outlines when they are far apart", () => {
    expect(contour(new Field([box(-120), box(120)], 10), { cell: 4 })).toHaveLength(2);
  });

  it("returns one outline when the blend closes the gap", () => {
    // This is the fusion claim itself: not "they look joined", but that the surface is a single
    // closed curve where a hard union has two.
    const shapes = [box(-46), box(46)];

    expect(contour(new Field(shapes, 0), { cell: 3 })).toHaveLength(2);
    expect(contour(new Field(shapes, 34), { cell: 3 })).toHaveLength(1);
  });

  it("pulls the joint inward, which is what makes it read as poured", () => {
    // The waist between two fused cards must be narrower than the cards; a blend that only
    // bridged them would leave a straight-sided slab.
    const loops = contour(new Field([box(-46), box(46)], 34), { cell: 3 });
    const seam = (loops[0] ?? []).filter((point) => Math.abs(point.x) < 3);

    expect(seam.length).toBeGreaterThan(0);
    expect(Math.max(...seam.map((point) => Math.abs(point.y)))).toBeLessThan(26);
  });
});

describe("the path it hands back", () => {
  it("is closed subpaths in the field's own coordinates", () => {
    const path = fieldToPath(new Field([box(0)], 12), { cell: 4 });

    expect(path.d.startsWith("M ")).toBe(true);
    expect(path.d.endsWith("Z")).toBe(true);
    expect(path.d).toContain("L ");
    expect(path.minX).toBeCloseTo(-52, 6);
    expect(path.width).toBeCloseTo(104, 6);
  });

  it("is one subpath per island", () => {
    const fused = fieldToPath(new Field([box(-46), box(46)], 34), { cell: 3 });
    const apart = fieldToPath(new Field([box(-120), box(120)], 10), { cell: 4 });

    expect(fused.d.split("Z").filter((part) => part.trim() !== "")).toHaveLength(1);
    expect(apart.d.split("Z").filter((part) => part.trim() !== "")).toHaveLength(2);
  });

  it("is empty for a field with nothing in it, rather than a throw", () => {
    // An empty group is an ordinary state — a section rendering before its cards exist — and it
    // has to render as no skin at all.
    expect(fieldToPath(new Field([], 10)).d).toBe("");
  });

  it("declines to sample a grid that would lock the page", () => {
    // A cell of 2 over this span is millions of samples. Returning nothing is the honest failure:
    // a blank skin is visible immediately, where a frozen tab is not.
    const huge: Shape = { kind: "box", cx: 0, cy: 0, hw: 4000, hh: 4000, r: 10 };

    expect(contour(new Field([huge], 0), { cell: 2 })).toEqual([]);
  });
});
