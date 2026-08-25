import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CORPUS_FIXTURES } from "@nap/bench/product/corpus";
import { CAPTURE_VIEWPORTS } from "@nap/bench/surface";
import { describe, expect, it } from "vitest";
import {
  CORPUS_PAGE,
  CORPUS_ROOT,
  corpusFixtureDir,
  corpusPagePath,
  corpusPageUrl,
  corpusScreenshotFile,
  missingCorpusArtefacts,
} from "./corpus-fixtures.ts";

/** The first eight bytes of every PNG. Cheaper than a decoder, and it catches an empty file. */
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

describe("the corpus on disk", () => {
  it("holds a page and both photographs for every fixture", () => {
    expect(missingCorpusArtefacts()).toEqual([]);
  });

  it("photographed something, rather than writing an empty file", () => {
    for (const fixture of CORPUS_FIXTURES) {
      for (const viewport of CAPTURE_VIEWPORTS) {
        const bytes = readFileSync(corpusScreenshotFile(fixture.id, viewport));

        expect(bytes.subarray(0, PNG_MAGIC.length)).toEqual(PNG_MAGIC);
        expect(bytes.byteLength).toBeGreaterThan(1024);
      }
    }
  });

  /**
   * The corpus is a controlled experiment: nine designs of one application. A fixture that
   * fetched a font or a script would be photographing whatever the network returned that day,
   * and two captures months apart would differ for a reason nothing recorded.
   */
  it("loads nothing over the network", () => {
    for (const fixture of CORPUS_FIXTURES) {
      const page = readFileSync(corpusPagePath(fixture.id), "utf8");

      expect(page).not.toMatch(/https?:\/\//);
      expect(page).not.toMatch(/<link[^>]+stylesheet/i);
      expect(page).not.toMatch(/<script[^>]+src=/i);
    }
  });

  it("declares a viewport, so the mobile capture is a mobile layout and not a zoomed page", () => {
    for (const fixture of CORPUS_FIXTURES) {
      const page = readFileSync(corpusPagePath(fixture.id), "utf8");

      expect(page).toMatch(/<meta name="viewport"/);
    }
  });
});

describe("corpusPageUrl", () => {
  it("is a file URL under the corpus root", () => {
    const url = corpusPageUrl("minimalist-professional");

    expect(url.startsWith("file://")).toBe(true);
    expect(decodeURIComponent(url)).toContain(CORPUS_ROOT);
  });
});

describe("corpusFixtureDir", () => {
  /**
   * The capture script writes into this directory and reads the page from it, so the two must be
   * the same place. They are derived separately, which is exactly how they could stop being.
   */
  it("is the directory the page and both photographs sit in", () => {
    const dir = corpusFixtureDir("correct-ugly");

    expect(dir).toBe(join(CORPUS_ROOT, "correct-ugly"));
    expect(corpusPagePath("correct-ugly")).toBe(join(dir, CORPUS_PAGE));
    expect(corpusScreenshotFile("correct-ugly", "mobile")).toBe(join(dir, "mobile.png"));
  });
});
