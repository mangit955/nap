import { describe, expect, it } from "vitest";
import { type SkinBox, skinPath } from "./skin.ts";

const tile = (id: string, x: number, y = 0): SkinBox => ({ id, x, y, w: 200, h: 120 });

/** How many islands the outline has. One means the boxes fused into a single surface. */
const islands = (d: string) => d.split("Z").filter((part) => part.trim() !== "").length;

describe("pouring a set of boxes", () => {
  it("traces one surface when the blend is more than twice the gap", () => {
    // The claim the whole directory exists to make. The threshold is not a matter of taste: the
    // blended field only goes negative between two boxes when `k` exceeds twice the gap, so a
    // layout using this has to pick the two numbers together. These tiles are 14 apart.
    expect(islands(skinPath([tile("a", 0), tile("b", 214)], { k: 40, cell: 4 }).d)).toBe(1);
  });

  it("traces one per box when the blend does not reach that far", () => {
    // Just under the threshold rather than miles away, because that is the failure a layout
    // actually hits — and on screen it looks like the effect was never wired up.
    expect(islands(skinPath([tile("a", 0), tile("b", 214)], { k: 24, cell: 4 }).d)).toBe(2);
    expect(islands(skinPath([tile("a", 0), tile("b", 600)], { k: 40, cell: 4 }).d)).toBe(2);
  });

  it("joins two distant boxes when a bridge asks for it", () => {
    const path = skinPath([tile("a", 0), tile("b", 600)], {
      k: 8,
      cell: 6,
      bridges: [{ from: "a", to: "b", width: 40 }],
    });

    expect(islands(path.d)).toBe(1);
  });

  it("ignores a bridge naming a box that is not there", () => {
    const path = skinPath([tile("a", 0)], { bridges: [{ from: "a", to: "ghost" }] });

    expect(islands(path.d)).toBe(1);
  });

  it("reports bounds that reach outside the boxes, because the skin does", () => {
    // The blend paints past every card. A caller that placed this at its own origin would clip
    // the top and left fillets only, which reads as a rendering fault rather than an offset.
    const path = skinPath([tile("a", 0)], { k: 20 });

    expect(path.minX).toBeLessThan(0);
    expect(path.minY).toBeLessThan(0);
  });

  it("draws nothing at all for no boxes", () => {
    expect(skinPath([]).d).toBe("");
  });
});
