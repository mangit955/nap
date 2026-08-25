/**
 * Where the fixture corpus lives on disk, and whether all of it is actually there.
 *
 * `packages/bench` says what the corpus *is* — the nine fixtures and what their grades must do —
 * and touches no filesystem, for the reason `docs/adr/0001` gives. This is the other half: it
 * resolves those ids to the hand-written page and the two committed photographs beside it.
 *
 * **The PNGs are committed, and that is what makes the corpus free.** They are taken once, by
 * `scripts/capture-corpus.ts`, against a local Chrome; nothing in the default suite launches a
 * browser to read them. The cost of that is a check nobody would otherwise perform — a tenth
 * fixture added and never photographed would leave a real judge with nothing to look at, and a
 * paid run reporting `not_assessable` on it is neither a pass nor a failure, so it would be
 * discovered as a puzzle in an expensive report. `missingCorpusArtefacts` is that check, and it
 * runs free.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CORPUS_FIXTURES,
  type CorpusFixtureId,
  corpusScreenshotPath,
} from "@nap/bench/product/corpus";
import { CAPTURE_VIEWPORTS } from "@nap/bench/surface";
import type { ViewportName } from "@nap/bench/viewport";

/** The page every fixture directory holds, and the only file the capture pass opens. */
export const CORPUS_PAGE = "index.html";

/**
 * Resolved from this module rather than from the working directory, because both callers run
 * from somewhere else: Vitest from the repository root, and the capture script from wherever
 * `bun run` was invoked.
 */
export const CORPUS_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../fixtures/corpus");

export function corpusFixtureDir(id: CorpusFixtureId): string {
  return join(CORPUS_ROOT, id);
}

/** The page itself, as a path. */
export function corpusPagePath(id: CorpusFixtureId): string {
  return join(corpusFixtureDir(id), CORPUS_PAGE);
}

/**
 * The page as a URL a browser will open.
 *
 * `file://` rather than a loopback server: these fixtures load nothing over the network — no
 * fonts, no scripts, no images — so a server would add a moving part to a capture that is
 * supposed to produce the same bytes every time.
 */
export function corpusPageUrl(id: CorpusFixtureId): string {
  return pathToFileURL(corpusPagePath(id)).href;
}

/** One committed photograph, as an absolute path. */
export function corpusScreenshotFile(id: CorpusFixtureId, viewport: ViewportName): string {
  return join(CORPUS_ROOT, corpusScreenshotPath(id, viewport));
}

/**
 * Everything the corpus claims to hold and does not, as paths relative to the corpus root.
 *
 * A list rather than a boolean, and relative rather than absolute, so a failure names the files
 * to go and produce instead of saying that something somewhere is missing.
 */
export function missingCorpusArtefacts(): string[] {
  const missing: string[] = [];

  for (const fixture of CORPUS_FIXTURES) {
    if (!existsSync(corpusPagePath(fixture.id))) missing.push(`${fixture.id}/${CORPUS_PAGE}`);

    for (const viewport of CAPTURE_VIEWPORTS) {
      if (!existsSync(corpusScreenshotFile(fixture.id, viewport))) {
        missing.push(corpusScreenshotPath(fixture.id, viewport));
      }
    }
  }

  return missing;
}
