/**
 * Where a badge sits and whether it may.
 *
 * Separated from the component because the non-overlap rule is the one part of the trail with a
 * right answer: everything else is timing and taste, checked by eye, but "no two badges ever
 * touch" is a property that either holds for every pair or does not hold at all. The trail tests
 * a candidate against every live badge and *skips* the drop on a hit rather than moving it, so
 * this is what limits density wherever the cursor doubles back on itself.
 *
 * A badge's width is computed rather than measured. Measuring means laying the span out, reading
 * it back and only then knowing whether it collides — a forced reflow inside an animation frame,
 * for text in a fixed monospace face at a fixed size, whose advance width is a constant.
 */

/** Font size of a badge's text, in px. Small enough to read as a label rather than a word. */
export const FONT_PX = 11;
/** Advance width of one character in the mono stack at `FONT_PX`. Measured, not guessed. */
const CHAR_W = 6.6;
export const PAD_X = 4;
export const PAD_Y = 1;
export const RADIUS = 3;
/**
 * How far apart two badges must stay. Small enough that they still read as a cluster, large
 * enough that the die-cut edges never appear to fuse into one shape.
 */
const GAP = 3;

export type Rect = { x: number; y: number; w: number; h: number };

export const BADGE_H = FONT_PX + PAD_Y * 2;

export function badgeW(text: string): number {
  return Math.round(text.length * CHAR_W) + PAD_X * 2;
}

/** Axis-aligned overlap test, with both boxes inflated by the gap. */
export function overlaps(a: Rect, b: Rect): boolean {
  return (
    a.x < b.x + b.w + GAP && a.x + a.w + GAP > b.x && a.y < b.y + b.h + GAP && a.y + a.h + GAP > b.y
  );
}
