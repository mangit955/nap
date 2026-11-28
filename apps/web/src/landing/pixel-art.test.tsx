import { render } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Landing } from "./landing.tsx";
import { Num1Mark } from "./num1-mark.tsx";
import { cellPaths, PIXEL_ICONS } from "./pixel-sprite.tsx";
import { pileCells } from "./start-now.tsx";
import { wordmarkCells } from "./wordmark.tsx";

describe("cellPaths", () => {
  it("draws one path per colour, one unit square per filled cell", () => {
    expect(cellPaths(["X.", ".Y"], { X: "#000", Y: "#fff" })).toEqual([
      { fill: "#000", d: "M0 0h1v1h-1z" },
      { fill: "#fff", d: "M1 1h1v1h-1z" },
    ]);
  });

  it("leaves a character it has no colour for empty", () => {
    expect(cellPaths(["X.X"], { X: "red" })).toEqual([
      { fill: "red", d: "M0 0h1v1h-1zM2 0h1v1h-1z" },
    ]);
  });

  it("is given icons that are all the same size, so the rows of them line up", () => {
    for (const rows of Object.values(PIXEL_ICONS)) {
      expect(rows).toHaveLength(7);
      for (const row of rows) expect(row).toHaveLength(9);
    }
  });
});

describe("the wordmark", () => {
  const cells = wordmarkCells("NUM1");

  it("is four 5×7 glyphs with a blank column between each", () => {
    expect(cells).toHaveLength(7);
    for (const row of cells) expect(row).toHaveLength(4 * 5 + 3);
    for (const column of [5, 11, 17]) {
      expect(cells.map((row) => row[column])).toEqual(Array(7).fill("empty"));
    }
  });

  it("is mid-construction: a block falling into the last gap, another gap waiting, one block cobalt", () => {
    const all = cells.flat();
    expect(all.filter((cell) => cell === "falling")).toHaveLength(1);
    expect(cells[6]?.[22]).toBe("falling");
    expect(all.filter((cell) => cell === "waiting")).toHaveLength(1);
    expect(all.filter((cell) => cell === "accent")).toHaveLength(1);
  });

  it("is announced once, as the name", () => {
    const { getByRole } = render(<Landing auth="signed-out" />);
    expect(getByRole("img", { name: "Num1" })).toHaveClass("n1-wm");
  });
});

describe("the pile in the closing band", () => {
  it("is the same blocks on every render", () => {
    expect(pileCells()).toEqual(pileCells());
  });

  it("rises to the right", () => {
    const cells = pileCells();
    const height = (x: number) =>
      Array.from({ length: 9 }, (_, y) => cells[y * 12 + x]).filter(
        (cell) => cell === "on" || cell === "ac",
      ).length;
    expect(cells).toHaveLength(12 * 9);
    expect(height(11)).toBeGreaterThan(height(0));
    expect(height(0)).toBeLessThanOrEqual(1);
    expect(height(11)).toBeGreaterThanOrEqual(8);
  });
});

describe("the placeholder mark", () => {
  it("draws light on an ink tile in the bar, and in the text colour elsewhere", () => {
    const tile = render(<Num1Mark tile />).container;
    expect(tile.querySelector(".n1-mark-tile path")).toHaveAttribute("fill", "#fff");
    const bare = render(<Num1Mark />).container;
    expect(bare.querySelector(".n1-mark-tile")).toBeNull();
    expect(bare.querySelector("path")).toHaveAttribute("fill", "currentColor");
  });
});

describe("the page before any script has run", () => {
  // Whatever hides content until it plays is keyed on `data-reveal`, which only the browser
  // writes once it has an observer to take it off again (`use-reveal.ts`).
  it("holds nothing back", () => {
    const html = renderToString(<Landing auth="signed-out" />);
    expect(html).not.toContain("data-reveal");
    expect(html).toContain("Import 214 rows");
  });
});
