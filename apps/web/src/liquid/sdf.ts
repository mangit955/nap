/**
 * The signed-distance field two boxes are poured out of.
 *
 * The whole trick is one idea: do not stack the shapes, take the union of their distance fields
 * with a *smooth* minimum. A plain `min` is a hard union — the shapes touch at a sharp seam. A
 * smooth minimum blends the fields near that seam, and the blend **is** the concave fillet where
 * two cards meet. One number, `k`, spans the whole range from a crisp inverse-rounded joint to an
 * organic melt, which is why nothing here draws a corner: every corner is a consequence.
 *
 * Convention, and the one thing to get right before reading anything below: the field is
 * **negative inside** a shape, zero on its surface, positive outside. The outline that gets drawn
 * is the contour at zero.
 *
 * This is deliberately plain CPU arithmetic with no DOM and no React in it, so the interesting
 * part — is that really one shape or two? — is checkable without rendering anything.
 */

/**
 * Distance from a point to an axis-aligned rounded box. `hw`/`hh` are half-extents, so a caller
 * passes the box's centre rather than its corner; that is what makes the smooth union symmetric
 * about the seam instead of biased towards one card's origin.
 */
export function sdRoundBox(
  px: number,
  py: number,
  cx: number,
  cy: number,
  hw: number,
  hh: number,
  r: number,
): number {
  // A radius larger than the box would invert the corner and turn the shape inside out at the
  // contour, so it is clamped here rather than trusted from the caller.
  const radius = Math.min(r, Math.min(hw, hh));
  const qx = Math.abs(px - cx) - hw + radius;
  const qy = Math.abs(py - cy) - hh + radius;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  return outside + inside - radius;
}

/**
 * Distance to a capsule — a line segment with a radius. It is what a deliberate pipe between two
 * cards is made of, for the case where they are too far apart for proximity alone to fuse them.
 */
export function sdCapsule(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
  r: number,
): number {
  const pax = px - ax;
  const pay = py - ay;
  const bax = bx - ax;
  const bay = by - ay;
  // A zero-length segment is a circle, not a division by zero.
  const denom = bax * bax + bay * bay || 1e-6;
  const h = Math.max(0, Math.min(1, (pax * bax + pay * bay) / denom));
  return Math.hypot(pax - bax * h, pay - bay * h) - r;
}

/**
 * The smooth minimum, which is the fillet maker.
 *
 * `k` is a distance, in the same units as everything else here: it is roughly how far either side
 * of the seam the two fields are allowed to influence each other. At zero this is exactly `min`
 * and the joint is a crease. The `- k * h * (1 - h)` term is the whole effect — it pulls the
 * result *below* both inputs near the seam, which is what bulges the surface outward into a
 * fillet rather than merely rounding the crease off.
 */
export function smin(a: number, b: number, k: number): number {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (b - a)) / k));
  return b * (1 - h) + a * h - k * h * (1 - h);
}

export type RoundBox = {
  kind: "box";
  cx: number;
  cy: number;
  hw: number;
  hh: number;
  r: number;
};

export type Bridge = {
  kind: "bridge";
  ax: number;
  ay: number;
  bx: number;
  by: number;
  r: number;
};

export type Shape = RoundBox | Bridge;

export function shapeSD(shape: Shape, px: number, py: number): number {
  return shape.kind === "box"
    ? sdRoundBox(px, py, shape.cx, shape.cy, shape.hw, shape.hh, shape.r)
    : sdCapsule(px, py, shape.ax, shape.ay, shape.bx, shape.by, shape.r);
}

/**
 * A group of shapes read as one surface.
 *
 * Fusing is a *consequence of proximity*, not something a caller asks for: two boxes whose blend
 * regions overlap merge with a fillet and nothing has to connect them. Bridges exist for the
 * other case, where the design wants two distant cards joined by a visible neck.
 */
export class Field {
  readonly shapes: readonly Shape[];
  readonly k: number;

  constructor(shapes: readonly Shape[] = [], k = 12) {
    this.shapes = shapes;
    this.k = k;
  }

  /** The fused distance at a point. An empty field is nowhere, hence infinity rather than zero. */
  eval(x: number, y: number): number {
    let distance = Number.POSITIVE_INFINITY;
    let first = true;
    for (const shape of this.shapes) {
      const d = shapeSD(shape, x, y);
      distance = first ? d : smin(distance, d, this.k);
      first = false;
    }
    return distance;
  }

  /**
   * The box the whole group lives in, padded by `k`.
   *
   * The pad is not tidiness: the fused skin bulges *outside* every card by up to about `k` at the
   * fillets, so a grid sized to the cards themselves would slice the blend off square at exactly
   * the place the effect happens.
   */
  bounds(pad = 0): { minX: number; minY: number; maxX: number; maxY: number } {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    const grow = pad + this.k;

    for (const shape of this.shapes) {
      const box =
        shape.kind === "box"
          ? {
              x0: shape.cx - shape.hw,
              y0: shape.cy - shape.hh,
              x1: shape.cx + shape.hw,
              y1: shape.cy + shape.hh,
            }
          : {
              x0: Math.min(shape.ax, shape.bx) - shape.r,
              y0: Math.min(shape.ay, shape.by) - shape.r,
              x1: Math.max(shape.ax, shape.bx) + shape.r,
              y1: Math.max(shape.ay, shape.by) + shape.r,
            };
      minX = Math.min(minX, box.x0 - grow);
      minY = Math.min(minY, box.y0 - grow);
      maxX = Math.max(maxX, box.x1 + grow);
      maxY = Math.max(maxY, box.y1 + grow);
    }

    if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    return { minX, minY, maxX, maxY };
  }
}
