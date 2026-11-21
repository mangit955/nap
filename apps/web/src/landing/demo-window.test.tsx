import { describe, expect, it } from "vitest";
import { chooseSpace } from "./demo-window.tsx";

/**
 * Which space a demo draws at a given column width. The bar is the product's 14px text drawn no
 * smaller than 9px and no larger than 14px, at every width; `scripts/check-landing.js` checks the
 * rendered result in a browser, and this checks the arithmetic it rests on across every width.
 */
const HERO = { wide: { width: 1280, height: 800 }, narrow: { width: 380, height: 720 } };
const ROW = { wide: { width: 900, height: 840 }, narrow: { width: 380, height: 760 } };
const text = (column: number, space: { width: number }) => (14 * column) / space.width;

describe("choosing a demo's space", () => {
  it("keeps the wide space until its text would fall under 9px, per demo", () => {
    expect(chooseSpace(823, HERO.wide, HERO.narrow).layout).toBe("wide");
    expect(chooseSpace(822, HERO.wide, HERO.narrow).layout).toBe("narrow");
    expect(chooseSpace(579, ROW.wide, ROW.narrow).layout).toBe("wide");
    expect(chooseSpace(578, ROW.wide, ROW.narrow).layout).toBe("narrow");
  });

  it("draws text between 9px and 14px at every column the page can give it", () => {
    // From a 320px phone's column (288, inside its margins and the backdrop's gutters) to the
    // widest each demo gets: the page's container stops at 1240px, which leaves the hero 1112 and
    // a row 756.
    for (const [demo, widest] of [
      [HERO, 1112],
      [ROW, 756],
    ] as const)
      for (let column = 288; column <= widest; column++) {
        const size = text(column, chooseSpace(column, demo.wide, demo.narrow));
        expect(size, `${demo.wide.width} at ${column}px`).toBeGreaterThanOrEqual(9);
        expect(size, `${demo.wide.width} at ${column}px`).toBeLessThanOrEqual(14);
      }
  });

  it("never lays the narrow space out narrower than it was designed for", () => {
    expect(chooseSpace(300, ROW.wide, ROW.narrow).width).toBe(380);
    expect(chooseSpace(500, ROW.wide, ROW.narrow).width).toBe(500);
  });
});
