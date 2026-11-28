import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The front page's motion promises two things (`num1.css`): it costs the scroll nothing, because
 * it animates only what the compositor can move on its own, and a reader who asked for reduced
 * motion gets none of it and has nothing held back waiting for it.
 *
 * Both are invisible to a component test — jsdom applies no stylesheet and runs no animation — and
 * a breach of either looks fine on the machine of whoever made it. So they are read from source.
 */
const SHEETS = ["./num1.css", "./showcase/showcase.css"].map((path) => ({
  path,
  css: readFileSync(new URL(path, import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, ""),
}));

/** Every rule, with the at-rules it sits inside, innermost last. */
function rules(css: string): { selector: string; body: string; within: string[] }[] {
  const found: { selector: string; body: string; within: string[] }[] = [];
  const stack: string[] = [];
  let buffer = "";
  for (const char of css) {
    if (char === "{") {
      stack.push(buffer.trim());
      buffer = "";
    } else if (char === "}") {
      const selector = stack.pop() ?? "";
      if (!selector.startsWith("@") && buffer.trim() !== "") {
        found.push({ selector, body: buffer, within: [...stack] });
      }
      buffer = "";
    } else {
      buffer += char;
    }
  }
  return found;
}

const ALL = SHEETS.flatMap(({ path, css }) => rules(css).map((rule) => ({ ...rule, path })));
const NO_PREFERENCE = "@media (prefers-reduced-motion: no-preference)";

describe("the front page's motion", () => {
  it("is found at all, so the checks below cannot pass on nothing", () => {
    expect(ALL.filter((rule) => /\banimation:/.test(rule.body)).length).toBeGreaterThan(4);
    expect(ALL.filter((rule) => /\btransition:/.test(rule.body)).length).toBeGreaterThan(2);
    expect(ALL.some((rule) => rule.selector === '.nap-reveal[data-reveal="pending"]')).toBe(true);
    expect(
      ALL.filter((rule) => rule.within.some((at) => at.startsWith("@keyframes"))).length,
    ).toBeGreaterThan(4);
  });

  it("plays only for readers who have not asked for less of it", () => {
    for (const rule of ALL.filter((each) =>
      /(?:^|[;\s])(?:animation|transition)(?:-[\w-]+)?\s*:|scroll-behavior:\s*smooth/.test(
        each.body,
      ),
    )) {
      expect(rule.within, `${rule.path}: ${rule.selector}`).toContain(NO_PREFERENCE);
    }
  });

  it("holds nothing back for readers who have", () => {
    // A rule that hides something until it is played must sit where the playing does.
    for (const rule of ALL.filter((each) => each.selector.includes('data-reveal="pending"'))) {
      expect(rule.within, `${rule.path}: ${rule.selector}`).toContain(NO_PREFERENCE);
    }
  });

  it("transitions only opacity and transform", () => {
    for (const rule of ALL.filter((each) => /\btransition:/.test(each.body))) {
      const value = rule.body.match(/\btransition:([^;]*)/)?.[1] ?? "";
      // Commas inside `cubic-bezier(…)` do not separate transitions.
      for (const part of value.split(/,(?![^(]*\))/)) {
        expect(["opacity", "transform"], `${rule.path}: ${rule.selector}`).toContain(
          part.trim().split(/\s+/)[0],
        );
      }
    }
  });

  it("animates only opacity and transform, which cost no layout", () => {
    const keyframes = ALL.filter((rule) => rule.within.some((at) => at.startsWith("@keyframes")));
    for (const frame of keyframes) {
      const properties = [...frame.body.matchAll(/([\w-]+)\s*:/g)].map(([, name]) => name);
      for (const property of properties) {
        expect(["opacity", "transform"], `${frame.path}: ${frame.within.at(-1)}`).toContain(
          property,
        );
      }
    }
  });
});

describe("the front page's focus ring", () => {
  it("is drawn on every link, in cobalt", () => {
    const ring = ALL.find((rule) => rule.selector === ".num1 :is(a, summary):focus-visible");
    expect(ring?.body).toMatch(/outline:\s*2px solid var\(--n1-blue\)/);
  });

  it("is drawn in the lighter blue on the dark band, where cobalt barely shows", () => {
    const band = ALL.find((rule) => rule.selector === ".num1 .n1-close a:focus-visible");
    expect(band?.body).toMatch(/outline-color:\s*var\(--n1-blue-hi\)/);
  });
});
