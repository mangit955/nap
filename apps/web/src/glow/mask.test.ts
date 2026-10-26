import { describe, expect, it } from "vitest";
import { buildMask, clampRadius, padOf, RIM_LAYERS, RIM_STOPS } from "./mask.ts";

// This file is collected by the `unit` project, which has no DOM — which is exactly what makes
// the no-canvas branch of `buildMask` testable here rather than only in a browser.

describe("padOf", () => {
  it("leaves room for the whole blur, not just the stroke", () => {
    // A blurred stroke reaches roughly three radii past its own edge; short-change it and the
    // softest light is clipped to a square.
    expect(padOf(20, 32)).toBe(116);
    expect(padOf(4, 4)).toBe(16);
  });

  it("is zero for the unblurred border layer, which paints inside the box", () => {
    expect(padOf(0, 0)).toBe(0);
  });
});

describe("clampRadius", () => {
  it("never exceeds half the shorter side", () => {
    expect(clampRadius(9999, 200, 60)).toBe(30);
    expect(clampRadius(16, 200, 60)).toBe(16);
  });

  it("never goes negative, however far the caller insets", () => {
    expect(clampRadius(-4, 200, 60)).toBe(0);
  });
});

describe("buildMask", () => {
  it("yields nothing where there is no canvas to draw on, rather than throwing", () => {
    // The box then renders unlit. A thrown error here would take the whole landing page down
    // over an ornament.
    expect(
      buildMask({ width: 600, height: 96, radius: 16, strokeWidth: 4, blur: 4, stops: RIM_STOPS }),
    ).toBe("");
  });
});

describe("RIM_LAYERS", () => {
  it("carves its border from a fill rather than stroking at width 1", () => {
    // A 1px stroke straddles the path, so half of it lands outside the shape and the border
    // reads as blurry. The fill-and-punch layer is the one with no stroke width at all.
    const border = RIM_LAYERS.filter((layer) => layer.strokeWidth === 0);
    expect(border).toHaveLength(1);
    expect(border[0]?.ring).toBe(1);
  });

  it("widens and softens together, so the light falls off with distance", () => {
    const glow = RIM_LAYERS.filter((layer) => layer.strokeWidth > 0);
    for (let index = 1; index < glow.length; index += 1) {
      expect(glow[index]?.strokeWidth).toBeGreaterThan(glow[index - 1]?.strokeWidth ?? 0);
      expect(glow[index]?.blur).toBeGreaterThan(glow[index - 1]?.blur ?? 0);
    }
  });
});

describe("RIM_STOPS", () => {
  it("leaves most of the rim unlit", () => {
    // The opacity gradient is what makes this a highlight travelling an edge. Light the whole
    // ring evenly and it becomes a glowing border instead.
    const transparent = RIM_STOPS.filter((stop) => stop.color === "transparent");
    expect(transparent).toHaveLength(2);
    const [from, to] = transparent;
    expect((to?.stop ?? 0) - (from?.stop ?? 0)).toBeGreaterThan(180);
  });
});
