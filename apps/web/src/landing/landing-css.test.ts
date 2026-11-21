import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The landing page draws its focus ring in `currentColor`, which is right for text links and
 * wrong for a button whose text is dark on a light fill: the ring sits outside the fill, on the
 * dark page, in the dark text colour, and cannot be seen. So each light-filled control carries
 * its own ring colour, and that rule has to *win* against the page-wide one. A first fix wrote
 * the colour on a selector the page-wide rule outranked, and a check that only looked for the
 * declaration passed it.
 *
 * Read from source because jsdom computes no outline colours; `scripts/check-landing.js` checks
 * the rendered contrast in a real browser.
 */
const css = readFileSync(new URL("./landing.css", import.meta.url), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(
  ([, selector = "", body = ""], at) => ({
    selector: selector.trim(),
    body,
    at,
  }),
);

/** Specificity as [ids, classes, elements], enough for this stylesheet's selectors. `:is()`
 *  counts as its most specific argument, per the spec. */
function specificity(selector: string): [number, number, number] {
  let rest = selector;
  let extra: [number, number, number] = [0, 0, 0];
  for (const [whole, inner = ""] of selector.matchAll(/:is\(([^)]*)\)/g)) {
    const best = inner
      .split(",")
      .map((part) => specificity(part.trim()))
      .sort((a, b) => b[0] - a[0] || b[1] - a[1] || b[2] - a[2])[0];
    if (best) extra = [extra[0] + best[0], extra[1] + best[1], extra[2] + best[2]];
    rest = rest.replace(whole, "");
  }
  const ids = (rest.match(/#[\w-]+/g) ?? []).length;
  const classes = (rest.match(/\.[\w-]+|:[\w-]+|\[[^\]]*\]/g) ?? []).length;
  const elements = (rest.match(/(?:^|[\s>+~])[a-z][\w-]*/g) ?? []).length;
  return [ids + extra[0], classes + extra[1], elements + extra[2]];
}
const beats = (a: string, aAt: number, b: string, bAt: number) => {
  const [x, y] = [specificity(a), specificity(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) > (y[i] ?? 0);
  return aAt > bAt;
};

describe("the landing page's focus ring", () => {
  it("counts specificity the way the browser does", () => {
    expect(specificity(".landing :is(a, button, select, summary):focus-visible")).toEqual([
      0, 2, 1,
    ]);
    expect(specificity(".lp-button-light:focus-visible")).toEqual([0, 2, 0]);
    expect(
      beats(".lp-button-light:focus-visible", 9, ".landing :is(a, button):focus-visible", 1),
    ).toBe(false);
  });

  it("is drawn in the page's ink on every light-filled control, by a rule that wins", () => {
    const page = rules.find((rule) => /^\.landing :is\(.*\):focus-visible$/.test(rule.selector));
    expect(page?.body).toMatch(/outline/);
    const light = rules.filter((rule) => /background:\s*var\(--lp-ink\)/.test(rule.body));
    expect(light.length).toBeGreaterThan(0);
    for (const { selector } of light) {
      const focus = rules.find(
        (rule) =>
          rule.selector.endsWith(`${selector}:focus-visible`) &&
          /outline-color:\s*var\(--lp-ink\)/.test(rule.body),
      );
      expect(focus, `${selector} needs its own focus ring colour`).toBeDefined();
      if (focus === undefined || page === undefined) continue;
      expect(
        beats(focus.selector, focus.at, page.selector, page.at),
        `${focus.selector} must outrank ${page.selector}`,
      ).toBe(true);
    }
  });
});
