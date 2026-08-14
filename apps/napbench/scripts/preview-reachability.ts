/**
 * Answers one question, once, with real money: can a host-side browser reach an E2B preview?
 *
 * `bun run napbench:preview-spike --real`
 *
 * Every browser and accessibility check NapBench will run assumes the answer is yes, and the
 * public proxy fronting a sandbox is the likeliest thing to fail a funded benchmark run for
 * reasons that have nothing to do with agent quality. This buys the answer for one throwaway
 * sandbox before the Playwright adapter is built on top of the assumption.
 *
 * Deliberately a spike: the code may be thrown away, the recorded answer is the deliverable.
 * What counts as an answer lives in `../src/preview-spike.ts`, where it is tested; this file
 * is credentials, a real sandbox, a real browser and output.
 *
 * It measures rather than asserts — `waitForPreview` already polls until the URL serves, but
 * it reports only the last reason, and the interesting data is every attempt: how many, how
 * far apart, and what each one said. So the polling is done here, in the open.
 */

import { join } from "node:path";
import { E2BSandboxManager } from "@nap/sandbox/e2b-sandbox-manager";
import { NAP_TEMPLATE, TEMPLATE_DEV_PORT } from "@nap/sandbox/template";
import { loadEnvFile } from "@nap/shared/env-file";
import { chromium, type Page } from "playwright-core";
import {
  type BrowserFindings,
  formatSpikeReport,
  PREVIEW_SPIKE_USAGE,
  type PreviewProbe,
  type PreviewSpikeObservations,
  parsePreviewSpikeArgs,
  summarisePreviewSpike,
} from "../src/preview-spike.ts";

/** Credentials live here by convention; Bun only auto-loads a `.env` from the working directory. */
const ENV_FILE = join(import.meta.dirname, "..", "..", "..", "apps", "api", ".env");

/** Ceiling on a single probe, so one stalled request cannot consume the whole budget. */
const PROBE_TIMEOUT_MS = 5_000;

/** Time after load for late console errors and the HMR socket to show themselves. */
const SETTLE_MS = 2_000;

const parsed = parsePreviewSpikeArgs(process.argv.slice(2));
if (!parsed.ok) {
  console.error(`${parsed.error}\n\n${PREVIEW_SPIKE_USAGE}`);
  process.exit(1);
}
const options = parsed.value;

if (!options.real) {
  console.log(
    [
      "Dry run. With --real this would:",
      `  1. create one E2B sandbox from the ${NAP_TEMPLATE} template (billed by the second)`,
      `  2. poll its preview URL on port ${TEMPLATE_DEV_PORT} every ${options.pollMs}ms for up to ${options.timeoutMs}ms`,
      "  3. open the URL in a real Chrome and try to drive the page",
      `  4. ${options.keep ? "leave the sandbox running" : "destroy the sandbox"}`,
      "",
      "There is no useful fake: an in-memory sandbox has no address a browser could load,",
      "and whether that address works is the entire question.",
      "",
      PREVIEW_SPIKE_USAGE,
    ].join("\n"),
  );
  process.exit(0);
}

loadEnvFile(ENV_FILE, process.env);

// A browser path is as required as the API key here: this spike is about a browser, and one
// that quietly fell back to an HTTP check would answer a different question convincingly.
for (const key of ["E2B_API_KEY", "NAP_CHROME_PATH"]) {
  if (process.env[key]) continue;
  console.error(`${key} is not set. Add it to ${ENV_FILE}, or export it, then retry.`);
  process.exit(1);
}
const chromePath = process.env.NAP_CHROME_PATH ?? "";

console.log("REAL RUN — one E2B sandbox, billed by the second, and a real browser.\n");

const sandbox = new E2BSandboxManager({ template: NAP_TEMPLATE });

const createStartedAt = Date.now();
const created = await sandbox.create(crypto.randomUUID());
if (!created.ok) {
  console.error(`Could not create a sandbox: ${created.error.code} — ${created.error.message}`);
  process.exit(1);
}
const createMs = Date.now() - createStartedAt;
const sandboxId = created.value.id;
console.log(`Sandbox ${sandboxId} created in ${createMs}ms.`);

try {
  const url = await sandbox.getPreviewUrl(sandboxId, TEMPLATE_DEV_PORT);
  if (!url.ok) throw new Error(`no preview URL: ${url.error.message}`);
  console.log(`Preview URL: ${url.value}\nProbing…`);

  const probes = await probeUntilItServes(url.value);
  const served = probes.some((probe) => probe.outcome === "ok");
  for (const probe of probes) {
    console.log(`  ${probe.attempt}. +${probe.elapsedMs}ms ${probe.outcome} — ${probe.detail}`);
  }

  const observations: PreviewSpikeObservations = {
    sandboxId,
    previewUrl: url.value,
    createMs,
    probes,
    browser: served ? await driveTheBrowser(url.value) : undefined,
  };

  console.log(`\n${formatSpikeReport(observations, summarisePreviewSpike(observations))}`);
} finally {
  if (options.keep) {
    console.log(`\nSandbox ${sandboxId} left running — it is billed until it is destroyed.`);
  } else {
    const destroyed = await sandbox.destroy(sandboxId);
    console.log(
      destroyed.ok
        ? `\nSandbox ${sandboxId} destroyed.`
        : `\nSandbox ${sandboxId} could NOT be destroyed (${destroyed.error.message}) — kill it by hand.`,
    );
  }
}

/** Polls the preview URL until something answers or the deadline passes, recording each try. */
async function probeUntilItServes(url: string): Promise<PreviewProbe[]> {
  const startedAt = Date.now();
  const deadline = startedAt + options.timeoutMs;
  const probes: PreviewProbe[] = [];

  for (let attempt = 1; Date.now() < deadline; attempt++) {
    try {
      const response = await fetch(url, {
        redirect: "follow",
        signal: AbortSignal.timeout(Math.min(PROBE_TIMEOUT_MS, deadline - Date.now())),
      });
      probes.push({
        attempt,
        elapsedMs: Date.now() - startedAt,
        outcome: response.ok ? "ok" : "status",
        detail: `HTTP ${response.status}`,
      });
      if (response.ok) return probes;
    } catch (cause) {
      probes.push({
        attempt,
        elapsedMs: Date.now() - startedAt,
        // A refused connection is the normal state while a dev server boots.
        outcome: "error",
        detail: cause instanceof Error ? cause.message : String(cause),
      });
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(options.pollMs, remaining)));
  }

  return probes;
}

/**
 * Loads the preview in a real browser and tries to *drive* it.
 *
 * Loading is not the question — an HTTP client can do that. What the benchmark needs is
 * everything a browser check does: query the DOM by role, read text, click something, and
 * see the result. If any of that fails through the proxy, browser checks are not viable.
 */
async function driveTheBrowser(url: string): Promise<BrowserFindings> {
  const browser = await chromium.launch({ executablePath: chromePath, headless: true });
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  let hmrConnected = false;

  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(options.browserTimeoutMs);
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
    page.on("requestfailed", (request) => {
      failedRequests.push(`${request.url()} (${request.failure()?.errorText ?? "unknown"})`);
    });
    // Vite's HMR client opens one. Whether it survives the proxy is worth knowing: it is
    // the difference between a real console error and one the adapter must ignore.
    page.on("websocket", (socket) => {
      socket.on("socketerror", () => {
        hmrConnected = false;
      });
      hmrConnected = true;
    });

    const gotoStartedAt = Date.now();
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: options.browserTimeoutMs });
    const gotoMs = Date.now() - gotoStartedAt;

    // The template is a Vite React app: the server sends an empty #root and the client
    // fills it. Content appearing there is the proof that scripts loaded and executed
    // through the proxy, which an HTTP 200 on the HTML says nothing about.
    let appRenderedMs: number | undefined;
    try {
      await page.waitForFunction(
        () => (document.querySelector("#root")?.childElementCount ?? 0) > 0,
        undefined,
        { timeout: options.browserTimeoutMs },
      );
      appRenderedMs = Date.now() - gotoStartedAt;
    } catch {
      appRenderedMs = undefined;
    }

    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

    return {
      gotoMs,
      appRenderedMs,
      title: await page.title(),
      scripted: appRenderedMs !== undefined && (await canDriveThePage(page)),
      consoleErrors,
      failedRequests,
      hmrConnected,
    };
  } finally {
    await browser.close();
  }
}

/** The things every browser check does, tried once against whatever the template renders. */
async function canDriveThePage(page: Page): Promise<boolean> {
  try {
    // Evaluate arbitrary script in the page, which is what every assertion rests on.
    const roundTrip = await page.evaluate(() => document.querySelectorAll("*").length);
    if (roundTrip <= 0) return false;

    // Query by role, the way NapBench's selectors will.
    const buttons = page.getByRole("button");
    const count = await buttons.count();
    if (count > 0) {
      await buttons.first().click({ timeout: options.browserTimeoutMs });
      // A click that lands proves the page is interactive, not merely painted.
      await page.evaluate(() => document.body.innerText.length);
    }

    // A screenshot is an artefact every scored run captures.
    const shot = await page.screenshot({ type: "png" });
    return shot.byteLength > 0;
  } catch (cause) {
    console.error(`  could not drive the page: ${cause instanceof Error ? cause.message : cause}`);
    return false;
  }
}
