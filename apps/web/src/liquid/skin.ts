/**
 * Cards that are poured rather than stacked.
 *
 * Given several rectangles, this returns **one** outline: where two of them are close enough
 * their distance fields blend, and the joint between them curves inward instead of meeting at a
 * crease. The caller paints that as a single filled path *behind* its real content, so everything
 * readable stays in ordinary DOM — real headings, real text, selectable and reachable. The fusion
 * is a background and never something a reader has to get past.
 *
 * **It takes geometry rather than measuring any.** Boxes come in as numbers in a design space the
 * caller scales, which means the skin is correct on the first frame and on the server. Measuring
 * the DOM instead would need a layout pass before anything could be drawn, a resize observer to
 * keep it true, and a first paint with no skin at all.
 *
 * It is a plain function and not a component or an engine object: the path is a pure function of
 * the boxes and the blend. Anything that cached would only earn its keep if these numbers changed
 * every frame, and the one caller's numbers never change at all.
 */

import { type FieldPath, fieldToPath } from "./marching-squares.ts";
import { type Bridge, Field, type Shape } from "./sdf.ts";

export type SkinBox = {
  id: string;
  /** Top-left corner and size, in the caller's own coordinates. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Overrides `radius` for this box alone. */
  cornerRadius?: number;
};

export type SkinOptions = {
  /** How far the fields blend: small is a crisp inverse-rounded joint, large is a melt. */
  k?: number;
  /** Default corner radius. */
  radius?: number;
  /** Grid step for the trace. Smaller is crisper and costs a square of the time. */
  cell?: number;
  smooth?: number;
  /** Deliberate necks between two boxes that proximity alone would leave apart. */
  bridges?: readonly { from: string; to: string; width?: number }[];
};

export function skinPath(boxes: readonly SkinBox[], options: SkinOptions = {}): FieldPath {
  const { k = 24, radius = 20, cell = 6, smooth = 2, bridges = [] } = options;

  // Centres, because a distance field is symmetric about the middle of a box; a corner origin
  // would bias every blend towards the top left.
  const centred = boxes.map((box) => ({
    id: box.id,
    cx: box.x + box.w / 2,
    cy: box.y + box.h / 2,
    hw: box.w / 2,
    hh: box.h / 2,
    r: box.cornerRadius ?? radius,
  }));

  const shapes: Shape[] = centred.map((box) => ({
    kind: "box",
    cx: box.cx,
    cy: box.cy,
    hw: box.hw,
    hh: box.hh,
    r: box.r,
  }));

  const byId = new Map(centred.map((box) => [box.id, box]));
  for (const bridge of bridges) {
    const from = byId.get(bridge.from);
    const to = byId.get(bridge.to);
    // A bridge naming a box that is not here is a typo in the caller, and skipping it is right:
    // the group still draws, one neck short, where a throw would take a whole section down.
    if (from === undefined || to === undefined) continue;
    const neck: Bridge = {
      kind: "bridge",
      ax: from.cx,
      ay: from.cy,
      bx: to.cx,
      by: to.cy,
      r: (bridge.width ?? Math.min(from.hh, to.hh)) / 2,
    };
    shapes.push(neck);
  }

  return fieldToPath(new Field(shapes, k), { cell, smooth });
}
