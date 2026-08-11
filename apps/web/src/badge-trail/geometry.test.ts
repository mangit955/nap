import { describe, expect, it } from "vitest";
import { BADGE_H, badgeW, overlaps, type Rect } from "./geometry.ts";

/**
 * The trail's one hard rule. Everything else about the effect is timing and taste and is checked
 * by eye; "no two badges touch" is a property, and the whole density limit rests on it.
 */

const at = (x: number, y: number): Rect => ({ x, y, w: 40, h: BADGE_H });

describe("overlaps", () => {
  it("is true for a badge dropped on top of another", () => {
    expect(overlaps(at(10, 10), at(12, 11))).toBe(true);
  });

  it("is true for boxes that only just miss, since the gap counts as occupied", () => {
    // Abutting exactly: no pixel is shared, and the two die-cut edges would still fuse into one
    // shape on screen. The gap is what this test exists to hold.
    expect(overlaps(at(0, 0), at(40, 0))).toBe(true);
    expect(overlaps(at(0, 0), at(0, BADGE_H))).toBe(true);
  });

  it("is false once the gap is cleared on either axis alone", () => {
    expect(overlaps(at(0, 0), at(44, 0))).toBe(false);
    expect(overlaps(at(0, 0), at(0, BADGE_H + 4))).toBe(false);
  });

  it("is false for boxes that share a row but not a column", () => {
    // The common way to get an AABB test wrong is an `||` where an `&&` belongs, which reports a
    // hit for anything on the same row.
    expect(overlaps(at(0, 0), at(300, 0))).toBe(false);
  });

  it("is symmetric", () => {
    const pairs: Array<[Rect, Rect]> = [
      [at(0, 0), at(41, 2)],
      [at(0, 0), at(44, 0)],
      [at(5, 5), at(5, 5)],
    ];
    for (const [a, b] of pairs) expect(overlaps(a, b)).toBe(overlaps(b, a));
  });
});

describe("badgeW", () => {
  it("grows with the text, since a fixed width would clip the long words", () => {
    expect(badgeW("x-height")).toBeGreaterThan(badgeW("hue"));
  });

  it("leaves room for the horizontal padding on both sides", () => {
    expect(badgeW("")).toBe(8);
  });
});
