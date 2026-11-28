/**
 * The masthead: "NUM1" built from blocks on a 5×7 glyph grid, mid-construction. Most blocks are
 * placed, one is cobalt, one gap is a dashed outline still waiting for its block, and a cobalt
 * block is falling into the other (`.n1-wm-fall` in `num1.css` animates it settling).
 *
 * Every cell is a grid item sized by `aspect-ratio`, so the wordmark scales with its column and
 * holds its height before anything loads: nothing here can shift the layout.
 */

const GLYPHS: Record<string, readonly string[]> = {
  N: ["X...X", "XX..X", "X.X.X", "X..XX", "X...X", "X...X", "X...X"],
  U: ["X...X", "X...X", "X...X", "X...X", "X...X", "X...X", ".XXX."],
  M: ["X...X", "XX.XX", "X.X.X", "X.X.X", "X...X", "X...X", "X...X"],
  "1": ["..X..", ".XX..", "X.X..", "..X..", "..X..", "..X..", "XXXXX"],
};

/** `row,column` of the cells drawn differently from a placed block. */
const FALLING = "6,22";
const WAITING = new Set(["6,18"]);
const COBALT = new Set(["1,19"]);

type Cell = "empty" | "on" | "accent" | "waiting" | "falling";

/** The wordmark as rows of cells: one blank column between letters. */
export function wordmarkCells(word: string): Cell[][] {
  const rows = Array.from({ length: 7 }, (_, y) =>
    [...word].map((char) => GLYPHS[char]?.[y] ?? ".....").join("."),
  );
  return rows.map((row, y) =>
    [...row].map((char, x): Cell => {
      if (char !== "X") return "empty";
      const key = `${y},${x}`;
      if (key === FALLING) return "falling";
      if (WAITING.has(key)) return "waiting";
      return COBALT.has(key) ? "accent" : "on";
    }),
  );
}

const CELLS = wordmarkCells("NUM1");
const CLASS: Record<Cell, string | undefined> = {
  empty: undefined,
  on: "on",
  accent: "ac",
  waiting: "gh",
  falling: "gh n1-wm-fall",
};

export function Wordmark() {
  const columns = CELLS[0]?.length ?? 0;
  return (
    <div
      className="n1-wm"
      role="img"
      aria-label="Num1"
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {CELLS.flatMap((row, y) =>
        row.map((cell, x) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the grid is fixed; a cell is its position.
          <i key={`${y}-${x}`} className={CLASS[cell]} />
        )),
      )}
    </div>
  );
}
