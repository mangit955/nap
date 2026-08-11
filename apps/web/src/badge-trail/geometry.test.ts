import { describe, expect, it } from "vitest";
import { BADGE_H, badgeW, blocked, overlaps, type Rect, slideOut } from "./geometry.ts";

/**
 * The trail's two hard rules. Everything else about the effect is timing and taste and is checked
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

describe("blocked", () => {
  const headline: Rect = { x: 400, y: 200, w: 600, h: 140 };

  it("refuses a badge that would land on the text", () => {
    expect(blocked({ x: 500, y: 250, w: 60, h: BADGE_H }, [headline])).toBe(true);
  });

  it("refuses one that merely grazes it, since a badge against a letter reads as attached", () => {
    // Directly abutting the box on each side: no overlap at all, and on screen it is a word
    // with something stuck to it.
    expect(blocked({ x: 340, y: 250, w: 60, h: BADGE_H }, [headline])).toBe(true);
    expect(blocked({ x: 1000, y: 250, w: 60, h: BADGE_H }, [headline])).toBe(true);
  });

  it("allows one clear of it", () => {
    expect(blocked({ x: 300, y: 250, w: 60, h: BADGE_H }, [headline])).toBe(false);
    expect(blocked({ x: 500, y: 20, w: 60, h: BADGE_H }, [headline])).toBe(false);
  });

  it("keeps text further away than badges keep each other", () => {
    // The two clearances are separate numbers on purpose, and this is the direction that
    // matters: collapsing them to one would tuck badges against the headline.
    const grazing = { x: headline.x - 64, y: 250, w: 60, h: BADGE_H };
    expect(overlaps(grazing, headline)).toBe(false);
    expect(blocked(grazing, [headline])).toBe(true);
  });

  it("has nothing to refuse when the page marks nothing", () => {
    expect(blocked({ x: 500, y: 250, w: 60, h: BADGE_H }, [])).toBe(false);
  });
});

describe("slideOut", () => {
  const column: Rect = { x: 400, y: 200, w: 600, h: 400 };
  const STAGE = 1440;

  it("leaves a point outside the zone where it is", () => {
    expect(slideOut(120, 300, [column], STAGE)).toEqual([120, 300]);
    expect(slideOut(700, 50, [column], STAGE)).toEqual([700, 50]);
  });

  it("pushes a point inside out to the nearer side", () => {
    expect(slideOut(450, 300, [column], STAGE)[0]).toBeLessThan(400);
    expect(slideOut(950, 300, [column], STAGE)[0]).toBeGreaterThan(1000);
  });

  it("never parks it off the stage", () => {
    // A column against the left edge has no room on that side, so the point has to come out of
    // the other one — pinned to an edge it cannot leave, the trail would sit in the corner.
    const flush: Rect = { x: 0, y: 200, w: 600, h: 400 };
    const [x] = slideOut(40, 300, [flush], STAGE);

    expect(x).toBeGreaterThan(600);
    expect(x).toBeLessThanOrEqual(STAGE);
  });

  it("keeps the height it was given, since only the sideways move is wanted", () => {
    expect(slideOut(450, 300, [column], STAGE)[1]).toBe(300);
  });
});

describe("slideOut and blocked together", () => {
  // The pairing is the point: a deflected phantom that still cannot drop anything is worse than
  // no deflection, because the trail goes empty and reads as broken rather than as respectful.
  it("leaves the deflected point somewhere a badge is actually allowed", () => {
    const column: Rect = { x: 400, y: 200, w: 600, h: 400 };
    const widest = badgeW("x-height");

    for (const start of [420, 500, 700, 900, 980]) {
      const [x, y] = slideOut(start, 300, [column], 1440);
      const candidate = { x: x - widest / 2, y: y - BADGE_H / 2, w: widest, h: BADGE_H };

      expect(blocked(candidate, [column])).toBe(false);
    }
  });
});
