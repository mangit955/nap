/**
 * Putting a run's screenshots on disk — the filesystem half of `ScreenshotStore`, and therefore
 * the half that lives in the app rather than in `@nap/bench`. See `docs/adr/0001`.
 *
 * Each image gets a sidecar of its own rather than one manifest per run, and that is deliberate:
 * a manifest is a second place a run's screenshots are listed, and the report already is the
 * first. Two lists of the same thing drift, and the one people archive is whichever they happen
 * to have. A sidecar makes each *image* self-describing instead — copy one out of the directory
 * and it still says which task, run, check and size it came from.
 *
 * **Every failure is returned, never thrown.** The runner keeps going: an image is evidence
 * about a run rather than an observation of the application, so a full disk must degrade the
 * report instead of failing a run that has already been paid for.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  type CapturedScreenshot,
  type ScreenshotStore,
  screenshotFilename,
  screenshotMetadataFilename,
} from "@nap/bench/screenshot";

/**
 * A store that writes into one directory.
 *
 * Returns the file's name rather than its full path, because that is what a report carries: a
 * relative name survives the results directory being moved or archived, and an absolute one is
 * wrong the moment it is.
 */
export function fileScreenshotStore(resultsDir: string): ScreenshotStore {
  return async (screenshot: CapturedScreenshot) => {
    const name = screenshotFilename(screenshot.metadata);

    try {
      await mkdir(resultsDir, { recursive: true });
      await writeFile(join(resultsDir, name), screenshot.bytes);
      // The sidecar second: an image with no metadata is a picture nobody can interpret, but
      // metadata with no image is a claim about a file that is not there, which is worse.
      await writeFile(
        join(resultsDir, screenshotMetadataFilename(screenshot.metadata)),
        `${JSON.stringify(screenshot.metadata, null, 2)}\n`,
        "utf8",
      );
    } catch (error) {
      return {
        ok: false,
        error: `could not write ${name}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    return { ok: true, value: name };
  };
}
