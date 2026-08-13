/**
 * Turning a field into an outline.
 *
 * The field in `sdf.ts` knows the distance at any point; nothing yet knows where the *edge* is.
 * This samples the field on a grid and runs marching squares at the zero contour: each cell looks
 * at whether its four corners are inside or outside — sixteen cases — and emits up to two short
 * edges.
 *
 * **The endpoints are interpolated, not placed at the midpoint of a cell edge.** That single
 * detail is the difference between a staircase and a curve: the field is a real distance, so
 * where it crosses zero along a cell edge is known to well under a cell. The traced polyline is
 * then Chaikin-smoothed, which rounds the faceting the grid still leaves behind.
 *
 * Two cases are genuinely ambiguous — a cell with two opposite corners inside is either a pinch
 * or a pass-through — and are resolved by sampling the cell's centre. Guessing instead produces
 * an outline that is subtly wrong only where two shapes are about to fuse, which is the one place
 * anybody is looking.
 */

import type { Field } from "./sdf.ts";

const fmt = (value: number) => value.toFixed(2);

export type MarchOptions = {
  /** Grid step, in the field's own units. Smaller is crisper and costs a square of the time. */
  cell?: number;
  /** Chaikin passes over the traced loops. Zero leaves the raw marching-squares polyline. */
  smooth?: number;
};

type Point = { x: number; y: number };

/** A cell edge: 0 top, 1 right, 2 bottom, 3 left. */
type Edge = 0 | 1 | 2 | 3;
type Crossing = readonly [Edge, Edge];

/**
 * Which edges the contour crosses, per corner mask. Bits are TL 8, TR 4, BR 2, BL 1, set when
 * that corner is *inside*. Cases 5 and 10 are the ambiguous pair and are overridden below.
 */
const CROSSINGS: readonly (readonly Crossing[])[] = [
  [], // 0000 — wholly outside
  [[3, 2]],
  [[2, 1]],
  [[3, 1]],
  [[0, 1]],
  [
    [3, 2],
    [0, 1],
  ], // 0101 — ambiguous
  [[0, 2]],
  [[3, 0]],
  [[3, 0]],
  [[0, 2]],
  [
    [3, 0],
    [2, 1],
  ], // 1010 — ambiguous
  [[0, 1]],
  [[3, 1]],
  [[2, 1]],
  [[3, 2]],
  [], // 1111 — wholly inside
];

/** The two ways an ambiguous cell can be read. */
const PINCHED: readonly Crossing[] = [
  [3, 0],
  [2, 1],
];
const OPEN: readonly Crossing[] = [
  [3, 2],
  [0, 1],
];

/** Where the field crosses zero between two corner samples. */
function lerpEdge(x0: number, y0: number, v0: number, x1: number, y1: number, v1: number): Point {
  const denom = v0 - v1;
  // Two equal samples give no information about where the crossing is; the midpoint is the only
  // unbiased answer, and the case is vanishingly rare on a real distance field.
  const t = Math.abs(denom) < 1e-6 ? 0.5 : v0 / denom;
  const clamped = Math.max(0, Math.min(1, t));
  return { x: x0 + (x1 - x0) * clamped, y: y0 + (y1 - y0) * clamped };
}

/** A safety ceiling on the sample grid, so a tiny `cell` cannot lock the main thread. */
const MAX_SAMPLES = 400_000;

/**
 * Trace the field's zero contour into closed loops.
 *
 * A group with two islands returns two loops, which is exactly how a caller can tell whether the
 * shapes fused: one loop means one surface.
 */
export function contour(field: Field, options: MarchOptions = {}): Point[][] {
  const cell = Math.max(2, options.cell ?? 6);
  const bounds = field.bounds();
  const width = bounds.maxX - bounds.minX;
  const height = bounds.maxY - bounds.minY;
  if (width <= 0 || height <= 0) return [];

  const cols = Math.ceil(width / cell) + 1;
  const rows = Math.ceil(height / cell) + 1;
  if (cols * rows > MAX_SAMPLES) return [];

  const samples = new Float32Array(cols * rows);
  for (let j = 0; j < rows; j++) {
    const y = bounds.minY + j * cell;
    for (let i = 0; i < cols; i++) {
      samples[j * cols + i] = field.eval(bounds.minX + i * cell, y);
    }
  }

  // Every read below is inside the grid by construction, so a miss is a bug in this file rather
  // than a state the caller can reach — which is what the throw says.
  const at = (i: number, j: number): number => {
    const value = samples[j * cols + i];
    if (value === undefined) throw new Error("marching squares sampled outside its own grid");
    return value;
  };

  const segments: [Point, Point][] = [];

  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < cols - 1; i++) {
      const x0 = bounds.minX + i * cell;
      const y0 = bounds.minY + j * cell;
      const x1 = x0 + cell;
      const y1 = y0 + cell;
      const tl = at(i, j);
      const tr = at(i + 1, j);
      const br = at(i + 1, j + 1);
      const bl = at(i, j + 1);

      let mask = 0;
      if (tl < 0) mask |= 8;
      if (tr < 0) mask |= 4;
      if (br < 0) mask |= 2;
      if (bl < 0) mask |= 1;
      if (mask === 0 || mask === 15) continue;

      const pointOn = (edge: Edge): Point => {
        switch (edge) {
          case 0:
            return lerpEdge(x0, y0, tl, x1, y0, tr);
          case 1:
            return lerpEdge(x1, y0, tr, x1, y1, br);
          case 2:
            return lerpEdge(x0, y1, bl, x1, y1, br);
          default:
            return lerpEdge(x0, y0, tl, x0, y1, bl);
        }
      };

      let crossings = CROSSINGS[mask] ?? [];
      if (mask === 5 || mask === 10) {
        const centre = field.eval((x0 + x1) / 2, (y0 + y1) / 2);
        const pinched = mask === 5 ? centre < 0 : centre >= 0;
        crossings = pinched ? PINCHED : OPEN;
      }
      for (const [a, b] of crossings) segments.push([pointOn(a), pointOn(b)]);
    }
  }

  return stitch(segments, cell);
}

/**
 * Join loose segments into loops.
 *
 * Endpoints that should be the same point are computed twice, once from each cell, and can differ
 * in the last bits — so they are matched by snapping to a coarse grid rather than by equality. The
 * tolerance is half a cell, which is far larger than the floating-point error and far smaller than
 * the distance to any genuinely different crossing.
 */
/** One end of one segment: which segment it belongs to, and which of its two ends. */
type Endpoint = { segment: number; end: 0 | 1 };

function stitch(segments: [Point, Point][], cell: number): Point[][] {
  const eps = cell * 0.5;
  const key = (p: Point) => `${Math.round(p.x / eps)},${Math.round(p.y / eps)}`;

  const endpoints = new Map<string, Endpoint[]>();
  segments.forEach((segment, index) => {
    for (const end of [0, 1] as const) {
      const k = key(segment[end]);
      const existing = endpoints.get(k);
      if (existing === undefined) endpoints.set(k, [{ segment: index, end }]);
      else existing.push({ segment: index, end });
    }
  });

  const used = new Array<boolean>(segments.length).fill(false);
  const loops: Point[][] = [];

  for (let start = 0; start < segments.length; start++) {
    if (used[start] === true) continue;

    const loop: Point[] = [];
    let current = start;
    let end: 0 | 1 = 0;
    // A ring of segments cannot be longer than the set it is drawn from; the bound is what stops
    // a malformed adjacency map from spinning forever.
    for (let guard = 0; guard <= segments.length; guard++) {
      const segment = segments[current];
      if (segment === undefined || used[current] === true) break;
      used[current] = true;

      loop.push(segment[end]);
      // Annotated because the walk is self-referential — `end` is read from the segment this
      // finds, and inference gives up on the cycle rather than resolving it.
      const tail: Point = segment[end === 0 ? 1 : 0];

      const candidates: Endpoint[] = endpoints.get(key(tail)) ?? [];
      const next: Endpoint | undefined = candidates.find(
        (candidate) => used[candidate.segment] !== true,
      );
      if (next === undefined) break;
      current = next.segment;
      end = next.end;
    }

    if (loop.length >= 3) loops.push(loop);
  }

  return loops;
}

/**
 * Chaikin corner cutting: replace every point with two, a quarter and three quarters along its
 * edges. Two passes is enough to read as fluid; more starts shrinking the shape noticeably.
 */
function chaikin(points: Point[], passes: number): Point[] {
  let current = points;
  for (let pass = 0; pass < passes; pass++) {
    const next: Point[] = [];
    for (let i = 0; i < current.length; i++) {
      const a = current[i];
      const b = current[(i + 1) % current.length];
      if (a === undefined || b === undefined) continue;
      next.push({ x: a.x * 0.75 + b.x * 0.25, y: a.y * 0.75 + b.y * 0.25 });
      next.push({ x: a.x * 0.25 + b.x * 0.75, y: a.y * 0.25 + b.y * 0.75 });
    }
    current = next;
  }
  return current;
}

export type FieldPath = {
  /** One `d`, with a subpath per island. Empty when the field encloses nothing. */
  d: string;
  minX: number;
  minY: number;
  width: number;
  height: number;
};

/**
 * The whole pipeline: field → loops → smoothing → one SVG path.
 *
 * The bounds come back with it because the path is in the field's own coordinates, and the caller
 * needs them to place a `viewBox` over the same space rather than guessing at an offset.
 */
export function fieldToPath(field: Field, options: MarchOptions = {}): FieldPath {
  const bounds = field.bounds();
  const smooth = options.smooth ?? 2;
  const parts: string[] = [];

  for (const loop of contour(field, options)) {
    const points = smooth > 0 ? chaikin(loop, smooth) : loop;
    const first = points[0];
    if (first === undefined || points.length < 3) continue;
    const rest = points
      .slice(1)
      .map((point) => `L ${fmt(point.x)} ${fmt(point.y)}`)
      .join(" ");
    parts.push(`M ${fmt(first.x)} ${fmt(first.y)} ${rest} Z`);
  }

  return {
    d: parts.join(" "),
    minX: bounds.minX,
    minY: bounds.minY,
    width: bounds.maxX - bounds.minX,
    height: bounds.maxY - bounds.minY,
  };
}
