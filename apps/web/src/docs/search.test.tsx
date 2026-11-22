import { describe, expect, it } from "vitest";
import { outlineOf } from "./outline.ts";
import { DOCS_HOME, hrefOf } from "./pages.ts";
import { fold, highlight, search, snippetOf } from "./search.ts";
import { buildSearchIndex } from "./search-index.ts";
import { SECTIONS } from "./sections.tsx";

const index = buildSearchIndex();

describe("the search index", () => {
  it("has an entry for the home page, every page and every subheading", () => {
    const hrefs = index.map((entry) => entry.href);
    expect(hrefs).toContain(DOCS_HOME);
    for (const { id, Body } of SECTIONS) {
      expect(hrefs).toContain(hrefOf(id));
      for (const heading of outlineOf(Body).headings) {
        expect(hrefs).toContain(`${hrefOf(id)}#${heading.id}`);
      }
    }
  });

  it("finds every page from words of its own opening", () => {
    for (const { id, Body } of SECTIONS) {
      const query = outlineOf(Body).lede.split(" ").slice(0, 8).join(" ");
      const pages = search(index, query).pages.map((hit) => hit.entry.href);
      expect({ query, found: pages.includes(hrefOf(id)) }).toEqual({ query, found: true });
    }
  });

  it("finds every subheading by its own words", () => {
    for (const { id, Body } of SECTIONS) {
      for (const heading of outlineOf(Body).headings) {
        const sections = search(index, heading.text).sections.map((hit) => hit.entry.href);
        expect(sections).toContain(`${hrefOf(id)}#${heading.id}`);
      }
    }
  });

  it("finds a word that only appears in the body under a heading", () => {
    // "manifest" is in Verification's first subsection and in no heading.
    const { sections } = search(index, "manifest");
    expect(sections.map((hit) => hit.entry.href)).toContain(
      `${hrefOf("verification")}#a-check-has-three-outcomes-and-the-third-is-load-bearing`,
    );
  });
});

describe("search", () => {
  it("requires every word, in any order", () => {
    const both = search(index, "repair verification");
    expect(both.pages.length + both.sections.length).toBeGreaterThan(0);
    expect(search(index, "repair zzzqqq")).toEqual({ pages: [], sections: [] });
  });

  it("ranks a title match above a body match", () => {
    expect(search(index, "repair").pages[0]?.entry.href).toBe(hrefOf("verification"));
  });

  it("matches straight quotes against curly ones", () => {
    const { sections } = search(index, "repository's job");
    expect(sections[0]?.entry.title).toBe("An imported repository’s job is also reviewed");
  });

  it("lists every page when nothing has been typed", () => {
    const { pages, sections } = search(index, "  ");
    expect(pages).toHaveLength(SECTIONS.length + 1);
    expect(sections).toEqual([]);
  });
});

describe("snippetOf", () => {
  const text =
    "One two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen twenty twentyone twentytwo twentythree twentyfour twentyfive twentysix";

  it("starts at the text when the match is near the start", () => {
    expect(snippetOf(text, ["three"]).startsWith("One two three")).toBe(true);
  });

  it("cuts at word boundaries around a later match and marks the cuts", () => {
    const snippet = snippetOf(`${text} ${text}`, ["twentysix"]);
    expect(snippet).toMatch(/^…\S/);
    expect(snippet).toContain("twentysix");
    expect(snippet).toMatch(/\S…$/);
  });
});

describe("highlight", () => {
  it("marks every match at the original's offsets, curly quotes included", () => {
    expect(highlight("A repository’s Repair", [fold("repository's"), "repair"])).toEqual([
      { text: "A ", match: false },
      { text: "repository’s", match: true },
      { text: " ", match: false },
      { text: "Repair", match: true },
    ]);
  });
});
