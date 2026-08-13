/**
 * A `PageCapture` backed by headless Chrome.
 *
 * `puppeteer-core` rather than `puppeteer`: the second downloads a Chromium of its own on
 * install, which is a hundred and fifty megabytes added to every checkout and every deploy for
 * a browser most environments already have. This one is handed the path to an existing binary
 * and refuses to guess — a capture that silently found *some* browser is worse than one that
 * says it has none.
 *
 * **A browser per capture, closed in a `finally`.** A long-lived instance would be a second
 * process lifetime to own — crash handling, restart, shutdown on SIGTERM — for something that
 * runs once at the end of a turn. Launching costs a second or so, and the turn it hangs off is
 * measured in tens of them.
 *
 * **Nothing here throws.** Every failure a browser can produce — no binary at that path, a
 * page that never loads, a sandbox reclaimed mid-navigation — is an ordinary outcome of
 * photographing something that lives somewhere else, and the caller upstream must not upload an
 * empty file because one happened.
 */

import type {
  PageCapture,
  PageCaptureError,
  PageCaptureOptions,
} from "@nap/shared/ports/page-capture";
import type { Result } from "@nap/shared/result";
import { launch, TimeoutError } from "puppeteer-core";

/** 16:10, which is the shape of the tile the dashboard draws it in. */
const DEFAULT_WIDTH = 1200;
const DEFAULT_HEIGHT = 750;

/**
 * Long enough for a cold Vite page behind E2B's proxy, short enough that a dead preview does
 * not hold a browser open through the next turn.
 */
const DEFAULT_TIMEOUT_MS = 20_000;

/**
 * Time for the first paint to become the page, after the network goes quiet.
 *
 * Fonts swap and entrance animations run *after* the last response arrives, so a screenshot
 * taken the instant loading finishes catches an app mid-fade — which looks like a broken app
 * rather than a fast one.
 */
const SETTLE_MS = 600;

export type ChromePageCaptureOptions = {
  /** Path to a Chrome or Chromium binary. Nothing here looks for one. */
  executablePath: string;
};

export class ChromePageCapture implements PageCapture {
  readonly #executablePath: string;

  constructor(options: ChromePageCaptureOptions) {
    this.#executablePath = options.executablePath;
  }

  async capture(
    url: string,
    options: PageCaptureOptions = {},
  ): Promise<Result<Uint8Array, PageCaptureError>> {
    const width = options.width ?? DEFAULT_WIDTH;
    const height = options.height ?? DEFAULT_HEIGHT;
    const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    let browser: Awaited<ReturnType<typeof launch>> | undefined;
    try {
      browser = await launch({
        executablePath: this.#executablePath,
        headless: true,
        // Chrome's sandbox needs privileges a container process usually does not have, and this
        // one only ever loads a page we are already running for the user.
        args: ["--no-sandbox", "--disable-dev-shm-usage", "--hide-scrollbars"],
      });

      const page = await browser.newPage();
      await page.setViewport({ width, height });

      // `networkidle2` rather than `load`: a Vite app serves an empty shell and then fetches its
      // modules, so the load event fires on a blank page.
      await page.goto(url, { waitUntil: "networkidle2", timeout });
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

      return { ok: true, value: await page.screenshot({ type: "png" }) };
    } catch (error) {
      return { ok: false, error: describe(error) };
    } finally {
      // Best effort: a browser that cannot be closed is a leaked process, not a failed capture,
      // and reporting it as the second would lose a screenshot that already succeeded.
      await browser?.close().catch(() => {});
    }
  }
}

/**
 * Which kind of failure this was, in the caller's vocabulary.
 *
 * The distinction is worth keeping: a timeout says the app is slow or broken, and everything
 * else says this machine cannot take screenshots at all — one is per project, the other is a
 * misconfiguration somebody has to fix.
 */
function describe(error: unknown): PageCaptureError {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof TimeoutError) return { code: "timeout", message };
  return { code: "unavailable", message };
}
