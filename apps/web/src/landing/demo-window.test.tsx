import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { GitComparison } from "@nap/shared/git-protocol";
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { chooseSpace, DrawnDiff, isDrawn, narrowBelow } from "./demo-window.tsx";
import { ROW_WIDTH } from "./feature-art.tsx";
import { HERO_SPACE } from "./hero-demo.tsx";

/**
 * Which space a demo draws at a given column width. The bar is the product's 14px text drawn no
 * smaller than 9px and no larger than 14px, at every width; `scripts/check-landing.js` checks the
 * rendered result in a browser, and this checks the arithmetic it rests on across every width.
 */
const HERO = HERO_SPACE;
const ROW = { wide: { width: ROW_WIDTH, height: 840 }, narrow: { width: 360, height: 760 } };
/** The workspace's smallest labels, 12px, as drawn at a column width in a given space. */
/** The plan's 11.5px count, the smallest text that tells a demo's story, as drawn. */
const label = (column: number, space: { width: number }) => (11.5 * column) / space.width;

describe("choosing a demo's space", () => {
  it("keeps the wide space until its smallest story text would fall under 9px, per demo", () => {
    expect(chooseSpace(1002, HERO.wide, HERO.narrow).layout).toBe("wide");
    expect(chooseSpace(1001, HERO.wide, HERO.narrow).layout).toBe("narrow");
    expect(chooseSpace(705, ROW.wide, ROW.narrow).layout).toBe("wide");
    expect(chooseSpace(704, ROW.wide, ROW.narrow).layout).toBe("narrow");
  });

  it("switches where the stylesheet reserves each frame's height, so nothing moves on load", () => {
    // The frame's narrow height is a container query in `demo.css`, there before any script; the
    // space inside follows `chooseSpace`. Two numbers that must agree, kept in two languages.
    const css = readFileSync(join(import.meta.dirname, "demo.css"), "utf8");
    const queries = [...css.matchAll(/@container \(width < (\d+)px\) \{\s*([^{]+)\{/g)].map(
      ([, width = "", selector = ""]) => ({ width: Number(width), selector: selector.trim() }),
    );
    expect(queries).toEqual([
      { width: narrowBelow(HERO.wide.width), selector: ".lp-hero-demo .lp-demo-crop" },
      { width: narrowBelow(ROW.wide.width), selector: ".lp-demo:not(.lp-hero-demo) .lp-demo-crop" },
    ]);
  });

  it("draws the plan's count at 9px or more, and 14px text at no more than 14px, everywhere", () => {
    // From a 360px phone's column (288, inside its margins and the backdrop's gutters; a 320px
    // phone's 248 is below the bar, a known limit) to the widest each demo is ever given, measured
    // in Chrome: the hero 1119 at a 1279px window, a row 879 when the rows stack at 1023px.
    for (const [demo, widest] of [
      [HERO, 1120],
      [ROW, 880],
    ] as const)
      for (let column = 288; column <= widest; column++) {
        const space = chooseSpace(column, demo.wide, demo.narrow);
        expect(label(column, space), `${demo.wide.width} at ${column}px`).toBeGreaterThanOrEqual(9);
        expect(
          (label(column, space) * 14) / 11.5,
          `${demo.wide.width} at ${column}px`,
        ).toBeLessThanOrEqual(14);
      }
  });

  it("never lays the narrow space out narrower than it was designed for", () => {
    expect(chooseSpace(300, ROW.wide, ROW.narrow).width).toBe(360);
    expect(chooseSpace(500, ROW.wide, ROW.narrow).width).toBe(500);
  });
});

const FILE: GitComparison["files"][number] = {
  path: "db/schema.ts",
  previousPath: null,
  status: "added",
  additions: 1,
  deletions: 0,
  binary: false,
  truncated: false,
  patch: "@@ -0,0 +1,1 @@\n+export const accounts = pgTable('accounts', {})",
};

describe("a diff that waits until it has drawn", () => {
  const dom = (html: string) => {
    const root = document.createElement("div");
    root.innerHTML = html;
    return root;
  };

  it("counts the product's loading placeholder, and only that, as not drawn yet", () => {
    expect(isDrawn(dom('<details><p class="t3-diff-notice">Loading diff…</p></details>'))).toBe(
      false,
    );
    expect(isDrawn(dom("<details><diffs-container></diffs-container></details>"))).toBe(true);
    // When highlighting fails the product shows the patch as text under a notice of the same
    // class as the loading one; that is a finished diff and must be shown.
    expect(
      isDrawn(
        dom(
          '<details><p class="t3-diff-notice">Showing the raw patch because this patch is incomplete or unsupported.</p><pre class="t3-raw-patch">+a</pre></details>',
        ),
      ),
    ).toBe(true);
  });

  it("starts hidden on the product's placeholder and says when it has drawn", async () => {
    const drawn = vi.fn();
    const { container } = render(<DrawnDiff file={FILE} onDrawn={drawn} />);
    const box = container.querySelector(".lp-drawn-diff");
    if (box?.querySelector(".t3-diff-notice")?.textContent === "Loading diff…") {
      expect(box).toHaveAttribute("data-drawn", "false");
      expect(drawn).not.toHaveBeenCalled();
    }
    await waitFor(() => expect(isDrawn(box ?? document.body)).toBe(true));
    await waitFor(() => expect(box).toHaveAttribute("data-drawn", "true"));
    expect(drawn).toHaveBeenCalledTimes(1);
  });
});
