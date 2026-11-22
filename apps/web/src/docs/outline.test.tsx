import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { outlineOf } from "./outline.ts";
import { SECTIONS } from "./sections.tsx";
import { slugify, textOf } from "./text.ts";

/**
 * The outline is how the "On this page" list, the heading anchors and the search index know what a
 * page says. If it misses a heading, that heading has no entry anywhere and nothing else fails.
 */

// Walked up from the working directory: in the jsdom environment `import.meta.url` is an http://
// URL and cannot be turned back into a path.
const docsDir = (() => {
  for (let dir = process.cwd(); dir !== dirname(dir); dir = dirname(dir)) {
    const candidate = join(dir, "apps/web/src/docs");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("could not find apps/web/src/docs from the working directory");
})();

describe("a section's outline", () => {
  it.each(SECTIONS.map((section) => [section.title, section] as const))(
    "%s: has its lede and every subheading its source declares",
    (_title, section) => {
      const outline = outlineOf(section.Body);
      const source = readFileSync(join(docsDir, section.file), "utf8");
      const declared = source.match(/<Sub>/g)?.length ?? 0;

      expect(outline.lede.length).toBeGreaterThan(20);
      expect(outline.headings).toHaveLength(declared);
      expect(new Set(outline.headings.map((heading) => heading.id)).size).toBe(declared);
      for (const block of outline.blocks) expect(block.text.length).toBeGreaterThan(0);
    },
  );

  it("separates words that sit in separate elements", () => {
    // The decisions list puts a title and its sentence in two paragraphs with no space between
    // them in the markup; read naively they become one run-on word.
    const decisions = SECTIONS.find((section) => section.id === "decisions");
    const text = decisions ? outlineOf(decisions.Body).blocks.map((block) => block.text) : [];
    expect(text.join(" ")).toContain("pure package and an app Tasks, scoring");
  });

  it("collapses the whitespace that JSX source carries across lines", () => {
    const verification = SECTIONS.find((section) => section.id === "verification");
    const lede = verification ? outlineOf(verification.Body).lede : "";
    expect(lede).toBe(
      "turn.completed is the model’s claim that the work is done, not the system’s finding that it is. Verification is what turns one into the other.",
    );
  });
});

describe("slugify", () => {
  it("keeps an apostrophe's word whole and drops punctuation", () => {
    expect(slugify("An imported repository’s job is also reviewed")).toBe(
      "an-imported-repositorys-job-is-also-reviewed",
    );
    expect(slugify("A check has three outcomes, and the third is load-bearing")).toBe(
      "a-check-has-three-outcomes-and-the-third-is-load-bearing",
    );
  });
});

describe("textOf", () => {
  it("reads strings, numbers and nested children, and skips booleans and nulls", () => {
    expect(textOf(["a ", 1, null, false, " b"])).toBe("a 1 b");
  });
});
