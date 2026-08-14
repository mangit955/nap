/**
 * Proves the assumption the preview spike rests on, without a sandbox and without a network:
 * that `playwright-core` can drive *this machine's* Chrome through the exact operations every
 * NapBench browser check will perform.
 *
 * It exists because the spike's recorded answer originally leaned on an ad-hoc check that
 * nobody else could re-run. Splitting the two questions is the point — this one is about the
 * browser and is free, and the paid run then buys only the one about E2B's proxy.
 *
 * Needs: a Chrome or Chromium binary named by `NAP_CHROME_PATH`. No network, no credentials,
 * no sandbox. It serves its own page on a loopback port, the way the capture package's
 * browser test does.
 */

import { createServer, type Server } from "node:http";
import { chromium } from "playwright-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const CHROME = process.env.NAP_CHROME_PATH;

/**
 * Shaped like the starter template: an empty `#root` that only script can fill. A page whose
 * content arrived in the HTML would prove nothing about whether scripts ran.
 */
const PAGE = `<!doctype html><html><head><title>Nap app</title></head><body>
<div id="root"></div>
<script>
  const root = document.getElementById("root");
  const button = document.createElement("button");
  let count = 0;
  button.textContent = "Count 0";
  button.onclick = () => { count++; button.textContent = "Count " + count; };
  root.appendChild(button);
</script></body></html>`;

/**
 * Launching, with the binary check the `skipIf` above has already made. It has to be restated
 * for the compiler: `exactOptionalPropertyTypes` refuses a possibly-undefined `executablePath`,
 * and a `??  ""` fallback would launch nothing at a path that cannot exist.
 */
function launchChrome() {
  if (CHROME === undefined) throw new Error("unreachable: guarded by describe.skipIf");
  return chromium.launch({ executablePath: CHROME, headless: true });
}

let server: Server;
let origin: string;
/** Recorded server-side: the favicon request is not visible on Playwright's `request` event. */
const pathsRequested: string[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    pathsRequested.push(request.url ?? "");
    // Everything but the page 404s, exactly as a dev server does for a file that is not there.
    if (request.url !== "/") {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html" });
    response.end(PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(() => {
  server?.close();
});

describe.skipIf(CHROME === undefined)("playwright-core against a real Chrome", () => {
  it("navigates, waits for script-rendered content, queries by role, clicks and photographs", async () => {
    // One test rather than five: launching a browser is the expensive part, and each step
    // depends on the one before it, so a split would pay that cost repeatedly to learn less.
    const browser = await launchChrome();
    try {
      const page = await browser.newPage();
      await page.goto(origin, { waitUntil: "domcontentloaded" });

      await page.waitForFunction(
        () => (document.querySelector("#root")?.childElementCount ?? 0) > 0,
      );
      expect(await page.title()).toBe("Nap app");

      const button = page.getByRole("button");
      await button.first().click();
      // The text changing is what separates a page that is interactive from one that is
      // merely painted — a click that lands on a dead page asserts nothing.
      expect(await button.first().textContent()).toBe("Count 1");

      const screenshot = await page.screenshot({ type: "png" });
      expect(screenshot.byteLength).toBeGreaterThan(0);
    } finally {
      await browser.close();
    }
  });

  it("sees Chrome request a favicon that is not there, which every benchmark run will hit", async () => {
    // The spike's one actionable finding. The starter template declares no <link rel="icon">
    // and ships no public/ directory, so Chrome asks for /favicon.ico unprompted and the dev
    // server 404s it. Unfiltered that is a console error in every trajectory NapBench ever
    // records, identical across every task, which looks like signal and is not.
    const browser = await launchChrome();
    try {
      const consoleErrors: string[] = [];
      const page = await browser.newPage();
      page.on("console", (message) => {
        if (message.type() === "error") consoleErrors.push(message.location().url);
      });
      await page.goto(origin, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => (document.querySelector("#root")?.childElementCount ?? 0) > 0,
      );

      // Chrome asks for it *after* the page has loaded, not as part of loading it. Asserting
      // straight after `waitForFunction` finds only "/" and misses this entirely — which is
      // also the reason the adapter has to settle before it collects console errors, or the
      // 404 lands in whichever run happened to be slow enough to see it.
      await expect
        .poll(() => pathsRequested, { timeout: 5_000 })
        .toEqual(expect.arrayContaining(["/favicon.ico"]));

      // And it reaches the page as a console error, which is how it would reach a trajectory.
      expect(consoleErrors.some((url) => url.endsWith("/favicon.ico"))).toBe(true);
    } finally {
      await browser.close();
    }
  });
});
