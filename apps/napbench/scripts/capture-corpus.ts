/**
 * Photographs the fixture corpus, once, so that every later use of it is free.
 *
 * `bun run napbench:corpus`
 *
 * The corpus is nine hand-written applications an evaluator has to be able to tell apart — see
 * `packages/bench/src/product/corpus.ts` for what each one is for. This walks them, opens each at
 * both capture viewports and writes the PNGs beside the page. Those PNGs are **committed**, which
 * is the whole economy of the thing: the discrimination check then costs a judge and nothing else,
 * and the free suite can assert the corpus is complete without launching a browser.
 *
 * **It photographs with the same instrument a real run uses.** `PlaywrightBrowserSession` is what
 * the benchmark drives, and going through it rather than calling Playwright directly means the
 * corpus images are produced by the code path under test: same launch flags, same viewport-sized
 * capture rather than a full-page one, same refusal to record a size it did not measure. A capture
 * script with its own opinions about how to take a screenshot would be a second implementation to
 * keep in step, and the difference would show up as a judge grading the corpus differently from
 * the way it grades a run.
 *
 * **Re-running it should produce the same bytes.** The fixtures load nothing over the network and
 * carry no animation, which the free suite asserts. Fonts are the one thing this cannot control:
 * the committed images were taken on macOS, and a capture on a host with a different system font
 * stack will differ visually. That is a reason to re-capture the whole corpus at once rather than
 * one fixture at a time — a corpus photographed on two machines is nine applications differing in
 * a way nobody intended.
 *
 * Needs a Chrome or Chromium at `NAP_CHROME_PATH`, and nothing else. No credentials, no network,
 * no sandbox, no money.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { CORPUS_FIXTURES } from "@nap/bench/product/corpus";
import { CAPTURE_VIEWPORTS } from "@nap/bench/surface";
import { viewportSize } from "@nap/bench/viewport";
import { loadEnvFile } from "@nap/shared/env-file";
import { corpusFixtureDir, corpusPageUrl, corpusScreenshotFile } from "../src/corpus-fixtures.ts";
import { launchPlaywrightBrowser } from "../src/playwright-browser-session.ts";

const ENV_FILE = "apps/api/.env";

// The same file the benchmark reads, and for the same reason: `NAP_CHROME_PATH` is already in it
// on any machine that has run a real benchmark, and asking for it to be exported as well would be
// a second place for one path to be wrong.
loadEnvFile(ENV_FILE, process.env);

const chromePath = process.env.NAP_CHROME_PATH;
if (!chromePath) {
  console.error(
    "NAP_CHROME_PATH is not set, and the corpus is photographed with a real browser.\n" +
      `Point it at a Chrome or Chromium binary — in ${ENV_FILE} or exported — then retry.`,
  );
  process.exit(1);
}

const launched = await launchPlaywrightBrowser({ executablePath: chromePath });
if (!launched.ok) {
  console.error(launched.error.message);
  process.exit(1);
}

let failed = false;

try {
  for (const fixture of CORPUS_FIXTURES) {
    await mkdir(corpusFixtureDir(fixture.id), { recursive: true });

    for (const viewport of CAPTURE_VIEWPORTS) {
      // A session per image rather than per fixture. One session is one check is the contract the
      // adapter is written against, and a page that had already been opened at desktop and then
      // resized is not the same page as one opened at mobile — which is precisely the difference
      // `desktop-only-breaks-mobile` exists to photograph.
      const opened = await launched.value.session();
      if (!opened.ok) {
        console.error(`${fixture.id} @ ${viewport}: ${opened.error.message}`);
        failed = true;
        continue;
      }

      const session = opened.value;
      try {
        const sized = await session.setViewport(viewportSize(viewport));
        if (!sized.ok) throw new Error(sized.error.message);

        const arrived = await session.goto(corpusPageUrl(fixture.id));
        if (!arrived.ok) throw new Error(arrived.error.message);

        const shot = await session.screenshot();
        if (!shot.ok) throw new Error(shot.error.message);

        const file = corpusScreenshotFile(fixture.id, viewport);
        await writeFile(file, shot.value.bytes);
        console.log(
          `${fixture.id}/${viewport}.png — ${shot.value.viewport.width}×${shot.value.viewport.height}, ${shot.value.bytes.byteLength} bytes`,
        );
      } catch (error) {
        console.error(
          `${fixture.id} @ ${viewport}: ${error instanceof Error ? error.message : String(error)}`,
        );
        failed = true;
      } finally {
        await session.close();
      }
    }
  }
} finally {
  await launched.value.close();
}

// Non-zero on any missed image: a corpus that is nine-tenths photographed is one whose next paid
// run reports `not_assessable` on the fixture nobody noticed was absent.
process.exit(failed ? 1 : 0);
