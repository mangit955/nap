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

/**
 * How far a badge stays off anything the trail must not cross. Wider than the badge-to-badge
 * gap on purpose: two badges touching is untidy, a badge touching a sentence is a word with
 * something stuck to it.
 */
const CLEARANCE = 14;

/** Axis-aligned overlap test, with the second box inflated by `gap` on every side. */
export function intersects(a: Rect, b: Rect, gap: number): boolean {
  return (
    a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y
  );
}

/** Whether a candidate badge would touch one already on screen. */
export function overlaps(a: Rect, b: Rect): boolean {
  return intersects(a, b, GAP);
}

/**
 * Whether a candidate badge would land on top of something that has to stay legible.
 *
 * The trail is a background, and a background that runs under a headline is not texture, it is
 * interference — the words are what the page is for. Skipping the drop rather than moving it
 * keeps the trail a record of where the cursor went: it simply thins out across the text and
 * picks up again past it, the same way it thins out in its own clusters.
 */
export function blocked(candidate: Rect, zones: readonly Rect[]): boolean {
  return zones.some((zone) => intersects(candidate, zone, CLEARANCE));
}

/**
 * How far outside a zone the deflected point sits: half the widest badge, plus a little.
 *
 * **Putting the point *on* the boundary is the trap, and it is silent.** A badge is centred on
 * the point, so a point exactly on the edge still lands half of its box inside the zone, every
 * drop is refused, and the trail goes empty while the phantom slides along a wall dropping
 * nothing. It looks like the effect has died rather than like a rule being enforced.
 */
const ORBIT = 40;

/**
 * Slides a point out of any zone it has wandered into, to the nearer side.
 *
 * Only the phantom cursor is passed through this, never a real one — a cursor that could not be
 * put where its owner put it would be a page fighting the mouse. The phantom has no owner, and
 * left to drift it spends much of its time inside the column, where every drop is refused and
 * the trail quietly empties. Deflected, it runs along the edge of the text instead, which is
 * both busier and reads as the words pushing it away.
 */
export function slideOut(
  x: number,
  y: number,
  zones: readonly Rect[],
  width: number,
): [number, number] {
  let out = x;
  for (const zone of zones) {
    const left = zone.x - CLEARANCE - ORBIT;
    const right = zone.x + zone.w + CLEARANCE + ORBIT;
    if (out <= left || out >= right) continue;
    if (y <= zone.y - CLEARANCE || y >= zone.y + zone.h + CLEARANCE) continue;
    // The nearer side, unless that side is off the stage — a point pushed past an edge it
    // cannot leave would park the trail in the corner.
    const nearerLeft = out - left < right - out;
    out = nearerLeft && left > 0 ? left : right < width ? right : left;
  }
  return [out, y];
}
