/**
 * One path per colour, a unit square per filled cell: a sprite is a handful of DOM nodes however
 * many cells it has.
 */
export function cellPaths(
  rows: readonly string[],
  colors: Readonly<Record<string, string>>,
): { fill: string; d: string }[] {
  const paths = new Map<string, string>();
  rows.forEach((row, y) => {
    [...row].forEach((char, x) => {
      const fill = colors[char];
      if (fill !== undefined) paths.set(fill, `${paths.get(fill) ?? ""}M${x} ${y}h1v1h-1z`);
    });
  });
  return [...paths].map(([fill, d]) => ({ fill, d }));
}

/**
 * Pixel art from a grid of characters: each row is a string, each character a cell, and
 * `colors` says which characters are filled and with what. A character it does not name is
 * empty.
 *
 * Drawn as an SVG with one unit per cell and `crispEdges`, so the cells stay square at any size
 * and nothing is antialiased into a blur between them.
 */
export function PixelSprite({
  rows,
  colors,
  unit,
  className,
}: {
  rows: readonly string[];
  colors: Readonly<Record<string, string>>;
  /** Pixels per cell. */
  unit: number;
  className?: string;
}) {
  const width = rows[0]?.length ?? 0;
  return (
    <svg
      aria-hidden="true"
      className={className}
      width={width * unit}
      height={rows.length * unit}
      viewBox={`0 0 ${width} ${rows.length}`}
      shapeRendering="crispEdges"
    >
      {cellPaths(rows, colors).map((path) => (
        <path key={path.fill} fill={path.fill} d={path.d} />
      ))}
    </svg>
  );
}

/** The 9×7 icons of the loop and the capabilities. `X` is a filled cell. */
export const PIXEL_ICONS = {
  plan: ["XX.XXXXXX", ".........", "XX.XXXXX.", ".........", "XX.XXXXXX", ".........", "XX.XXXX.."],
  build: [
    "..X...X..",
    ".X.....X.",
    "X.......X",
    "X.......X",
    "X.......X",
    ".X.....X.",
    "..X...X..",
  ],
  check: [
    "XX.......",
    "XXXX.....",
    "XXXXXX...",
    "XXXXXXXX.",
    "XXXXXX...",
    "XXXX.....",
    "XX.......",
  ],
  look: ["..XXXXX..", ".X.....X.", "X..XXX..X", "X..XXX..X", "X..XXX..X", ".X.....X.", "..XXXXX.."],
  fix: ["X.......X", ".X.XXX.X.", "..XXXXX..", "XXXXXXXXX", "..XXXXX..", ".X.XXX.X.", "X.......X"],
  ship: ["X........", "XXXXXX...", "XXXXXXXX.", "XXXXXX...", "X........", "X........", "X........"],
  machine: [
    "XXXXXXXXX",
    "X.......X",
    "X.X.....X",
    "X..X....X",
    "X.X..XX.X",
    "X.......X",
    "XXXXXXXXX",
  ],
  repo: ["XXX......", "X..X.....", "XXX..XXXX", "X....X..X", "X....XXXX", ".....X...", ".....X..."],
  talk: ["XXXXXXXX.", "X......X.", "X.XX.X.X.", "X......X.", "XXX.XXXX.", "..XX.....", "..X......"],
  many: ["XXX.XXX..", "X.X.X.X..", "XXX.XXX..", ".........", "XXX.XXX..", "X.X.X.X..", "XXX.XXX.."],
} as const satisfies Record<string, readonly string[]>;

export type PixelIcon = keyof typeof PIXEL_ICONS;
