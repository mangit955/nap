import { cellPaths } from "./pixel-sprite.tsx";

/** Seven by seven, centred: the glyph is five cells wide with a column of margin each side. */
const GLYPH = ["..XX...", ".XXX...", "..XX...", "..XX...", "..XX...", "..XX...", ".XXXXX."];

/**
 * The Num1 mark — **a placeholder**: a blocky "1" standing in until the real mark exists. Every
 * place the front page draws the brand goes through this one component, so the real mark is a
 * change to this file alone — and to `app/(front)/icon.svg`, the tab's icon, drawn from the same
 * glyph.
 *
 * `tile` draws it light on an ink square, as the bar and the footer do; without it the glyph is
 * drawn in `currentColor`, as the product window's sidebar does.
 */
export function Num1Mark({ size = 16, tile = false }: { size?: number; tile?: boolean }) {
  const glyph = (
    <svg
      aria-hidden="true"
      width={size}
      height={size}
      viewBox="0 0 7 7"
      shapeRendering="crispEdges"
    >
      {cellPaths(GLYPH, { X: tile ? "#fff" : "currentColor" }).map((path) => (
        <path key={path.fill} fill={path.fill} d={path.d} />
      ))}
    </svg>
  );
  return tile ? <span className="n1-mark-tile">{glyph}</span> : glyph;
}
