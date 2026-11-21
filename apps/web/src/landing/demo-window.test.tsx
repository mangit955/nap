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
/** The plan's 11.5px count, the smallest text that tells a demo's story, as drawn. */
const label = (column: number, space: { width: number }) => (11.5 * column) / space.width;

describe("choosing a demo's space", () => {
  it("keeps the wide space until its smallest story text would fall under 9px, per demo", () => {
    expect(chooseSpace(1002, HERO.wide, HERO.narrow).layout).toBe("wide");
    expect(chooseSpace(1001, HERO.wide, HERO.narrow).layout).toBe("narrow");
    expect(chooseSpace(705, ROW.wide, ROW.narrow).layout).toBe("wide");
    expect(chooseSpace(704, ROW.wide, ROW.narrow).layout).toBe("narrow");
  });

  it("lays out every narrow space where the scale switches to it, so nothing moves on load", () => {
    // The narrow layout is container queries, there before any script; the scale inside follows
    // `chooseSpace`. Every query must be at the width its demo switches, in either stylesheet.
    const queries = ["demo.css", "features.css"].flatMap((file) => {
      const css = readFileSync(join(import.meta.dirname, file), "utf8");
      return [...css.matchAll(/@container \(width < (\d+)px\) \{/g)].map((match) => {
        // The block's selectors: everything before each `{` at the block's own depth.
        let depth = 0;
        let at = (match.index ?? 0) + match[0].length;
        let text = "";
        const selectors: string[] = [];
        for (; depth >= 0 && at < css.length; at++) {
          const char = css[at];
          if (char === "{") {
            if (depth === 0) selectors.push(text.replace(/\/\*[\s\S]*?\*\//g, "").trim());
            depth++;
            text = "";
          } else if (char === "}") {
            depth--;
            text = "";
          } else if (depth === 0) text += char;
        }
        return { file, width: Number(match[1]), selectors };
      });
    });
    expect(queries.map(({ file }) => file)).toEqual(["demo.css", "demo.css", "features.css"]);
    for (const { file, width, selectors } of queries) {
      expect(selectors.length, file).toBeGreaterThan(0);
      for (const selector of selectors) {
        const hero = selector.startsWith(".lp-hero-demo");
        const row = /^\.lp-(?:demo:not\(\.lp-hero-demo\)|review-demo)/.test(selector);
        expect(hero || row, `${file}: ${selector} names its demo`).toBe(true);
        expect(width, `${file}: ${selector}`).toBe(
          narrowBelow(hero ? HERO.wide.width : ROW.wide.width),
        );
      }
    }
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
    // The product's placeholder is what the first render holds. Asserted, not assumed: if the
    // product rewords it, `isDrawn` would take the placeholder for a drawn diff, and this fails.
    expect(box?.querySelector(".t3-diff-notice")).toHaveTextContent("Loading diff…");
    expect(box).toHaveAttribute("data-drawn", "false");
    expect(drawn).not.toHaveBeenCalled();
    await waitFor(() => expect(isDrawn(box ?? document.body)).toBe(true));
    await waitFor(() => expect(box).toHaveAttribute("data-drawn", "true"));
    expect(drawn).toHaveBeenCalledTimes(1);
  });
});
