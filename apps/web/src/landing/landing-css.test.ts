import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The landing page draws its focus ring in `currentColor`, which is right for text links and
 * wrong for a button whose text is dark on a light fill: the ring sits outside the fill, on the
 * dark page, in the dark text colour, and cannot be seen. Read from source because jsdom computes
 * no outline colours.
 */
const css = readFileSync(new URL("./landing.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector = "", body = ""]) => ({
  selector: selector.trim(),
  body,
}));

describe("the landing page's focus ring", () => {
  it("is drawn in the page's ink on every light-filled control", () => {
    const light = rules
      .filter((rule) => /background:\s*var\(--lp-ink\)/.test(rule.body))
      .map((rule) => rule.selector);
    expect(light.length).toBeGreaterThan(0);
    for (const selector of light) {
      const focus = rules.find((rule) => rule.selector === `${selector}:focus-visible`);
      expect(focus?.body, `${selector} needs its own focus ring colour`).toMatch(
        /outline-color:\s*var\(--lp-ink\)/,
      );
    }
  });
});
