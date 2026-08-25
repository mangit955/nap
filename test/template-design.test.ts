import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkPalette, contrastRatio, parseColorTokens } from "./template-design.ts";

const TEMPLATE_CSS = readFileSync(
  new URL("../packages/sandbox/template/src/index.css", import.meta.url),
  "utf8",
);

describe("the template's palette", () => {
  it("clears WCAG AA on every pair the primitives put together", () => {
    expect(checkPalette(TEMPLATE_CSS)).toEqual([]);
  });

  it("is actually being read, rather than parsed to nothing", () => {
    // The failure this guards against is the whole check going quiet because the token
    // block was renamed and the parser started returning an empty object — which would
    // make every contrast requirement vacuously pass.
    expect(Object.keys(parseColorTokens(TEMPLATE_CSS)).length).toBeGreaterThanOrEqual(12);
  });
});

describe("the palette check catches what it is for", () => {
  // A check that has never been observed failing is not known to work.
  it("fails when a text tone is lightened past the threshold", () => {
    const weakened = TEMPLATE_CSS.replace(
      "--color-ink-subtle: #6e675e",
      "--color-ink-subtle: #b8b2a9",
    );
    const violations = checkPalette(weakened);

    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.foreground === "ink-subtle")).toBe(true);
    expect(violations[0]?.actual).toBeLessThan(violations[0]?.minimum ?? 0);
  });

  it("fails when a token the requirements name has been removed", () => {
    const removed = TEMPLATE_CSS.replace("--color-accent:", "--color-brand:");
    const violations = checkPalette(removed);

    expect(violations.some((v) => v.reason === "missing")).toBe(true);
  });
});

describe("contrastRatio", () => {
  it("puts the extremes at 21:1 and identical colours at 1:1", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 1);
    expect(contrastRatio("#1c4fd8", "#1c4fd8")).toBeCloseTo(1, 5);
  });

  it("does not care which way round the pair is given", () => {
    expect(contrastRatio("#191817", "#fbfaf9")).toBeCloseTo(contrastRatio("#fbfaf9", "#191817"), 5);
  });

  it("reads three-digit hex, since a token may be written either way", () => {
    expect(contrastRatio("#fff", "#000")).toBeCloseTo(21, 1);
  });
});
