/**
 * The decisions the preview-reachability spike makes, separated from the run it performs.
 *
 * The spike answers one binary question — can a host-side browser reliably reach an E2B
 * preview URL? — and every browser check NapBench will ever run is built on the answer. The
 * run itself needs a real sandbox and a real browser, so it lives in a script; what counts
 * as an answer, and what the Playwright adapter must therefore do, lives here where it is
 * typechecked and tested.
 *
 * Two things this module deliberately refuses to conflate. **HTTP is not a browser**: a proxy
 * that answers `fetch` but breaks scripting would look healthy to `waitForPreview` and fail
 * every browser check downstream, so reachability requires the browser to have driven the
 * page. And **an app that throws is not an unreachable app**: console errors belong to the
 * generated application, which the benchmark exists to score, and counting them here would
 * report an infrastructure fault every time an agent wrote a bug.
 */

import type { Result } from "@nap/shared/result";

export const PREVIEW_SPIKE_DEFAULTS = {
  /** Generous: the point is to measure a cold start, not to impose one. */
  timeoutMs: 120_000,
  pollMs: 1_000,
  browserTimeoutMs: 30_000,
} as const;

export const PREVIEW_SPIKE_USAGE = [
  "Usage: bun run napbench:preview-spike [options]",
  "",
  "  --real                  Create a real E2B sandbox and drive a real browser. Costs money.",
  `  --timeout=<ms>          How long to wait for the preview to serve (default ${PREVIEW_SPIKE_DEFAULTS.timeoutMs})`,
  `  --poll=<ms>             Gap between probes (default ${PREVIEW_SPIKE_DEFAULTS.pollMs})`,
  `  --browser-timeout=<ms>  Per browser operation (default ${PREVIEW_SPIKE_DEFAULTS.browserTimeoutMs})`,
  "  --keep                  Leave the sandbox running instead of destroying it",
  "",
  "Without --real it prints what it would do and exits. There is no useful fake: an",
  "in-memory sandbox has no address a browser could load, and the address is the question.",
].join("\n");

export type PreviewSpikeOptions = {
  /** False means nothing is created and nothing is billed. */
  real: boolean;
  keep: boolean;
  timeoutMs: number;
  pollMs: number;
  browserTimeoutMs: number;
};

/** One HTTP attempt against the preview URL, timed from the moment the sandbox existed. */
export type PreviewProbe = {
  attempt: number;
  elapsedMs: number;
  /** `ok` is a 2xx; `status` is an answer we did not want; `error` is no answer at all. */
  outcome: "ok" | "status" | "error";
  detail: string;
};

/** What a real browser managed to do with the page, once something answered at the URL. */
export type BrowserFindings = {
  gotoMs: number;
  /** Time until the app rendered content, or undefined if it never did. */
  appRenderedMs: number | undefined;
  title: string;
  /** Whether the page could be driven — evaluated, queried, interacted with. */
  scripted: boolean;
  consoleErrors: string[];
  failedRequests: string[];
  /** Vite's HMR socket. Informative only: a benchmark never edits a running app. */
  hmrConnected: boolean;
};

export type PreviewSpikeObservations = {
  sandboxId: string;
  previewUrl: string;
  createMs: number;
  probes: PreviewProbe[];
  /** Absent when nothing ever answered, so there was no page to open. */
  browser: BrowserFindings | undefined;
};

export type PreviewSpikeVerdict = {
  /** The binary answer: a host-side browser can load *and drive* the preview. */
  reachable: boolean;
  /** Cold start including sandbox creation, or undefined if it never served. */
  firstServeMs: number | undefined;
  attempts: number;
  neededRetries: boolean;
  /** What the Playwright adapter has to do about it, in the words it should be built with. */
  adapterNotes: string[];
};

export function parsePreviewSpikeArgs(
  argv: readonly string[],
): Result<PreviewSpikeOptions, string> {
  const options: PreviewSpikeOptions = {
    real: false,
    keep: false,
    timeoutMs: PREVIEW_SPIKE_DEFAULTS.timeoutMs,
    pollMs: PREVIEW_SPIKE_DEFAULTS.pollMs,
    browserTimeoutMs: PREVIEW_SPIKE_DEFAULTS.browserTimeoutMs,
  };

  for (const arg of argv) {
    if (arg === "--real") {
      options.real = true;
      continue;
    }
    if (arg === "--keep") {
      options.keep = true;
      continue;
    }

    const duration = /^--(timeout|poll|browser-timeout)=(.*)$/.exec(arg);
    if (duration !== null) {
      const [, name = "", raw = ""] = duration;
      const ms = Number(raw);
      if (!Number.isFinite(ms) || ms <= 0) {
        return {
          ok: false,
          error: `--${name} needs a positive number of milliseconds, got "${raw}"`,
        };
      }
      if (name === "timeout") options.timeoutMs = ms;
      else if (name === "poll") options.pollMs = ms;
      else options.browserTimeoutMs = ms;
      continue;
    }

    return { ok: false, error: `unknown argument "${arg}"` };
  }

  return { ok: true, value: options };
}

export function summarisePreviewSpike(observations: PreviewSpikeObservations): PreviewSpikeVerdict {
  const { createMs, probes, browser } = observations;
  const servedAt = probes.find((probe) => probe.outcome === "ok");
  const notes: string[] = [];

  if (servedAt === undefined) {
    return {
      reachable: false,
      firstServeMs: undefined,
      attempts: probes.length,
      neededRetries: probes.length > 1,
      adapterNotes: [
        "Nothing ever answered at the preview URL, so the browser half of NapBench is blocked: " +
          "every browser and accessibility check depends on reaching a preview from the host. " +
          "Resolve this before the Playwright adapter is built on the assumption.",
      ],
    };
  }

  const neededRetries = servedAt.attempt > 1;
  if (neededRetries) {
    notes.push(
      `The preview did not answer on the first probe — it took ${servedAt.attempt} attempts over ` +
        `${servedAt.elapsedMs}ms. The adapter must poll until the URL serves before navigating; ` +
        "a single navigation against a cold preview would fail and be scored as a broken app.",
    );
  } else {
    notes.push("The preview answered on the first probe, but the adapter should still poll.");
  }

  if (browser === undefined) {
    return {
      reachable: false,
      firstServeMs: createMs + servedAt.elapsedMs,
      attempts: probes.length,
      neededRetries,
      adapterNotes: [
        ...notes,
        "HTTP served but no browser observation was recorded, so the question the spike exists " +
          "to answer is unanswered — blocked until a browser has driven the page.",
      ],
    };
  }

  if (!browser.scripted) {
    notes.push(
      "A browser could not drive the page through the proxy, which is the failure this spike " +
        "exists to catch: HTTP alone would have looked healthy. Until it can script the page, " +
        "browser checks are blocked.",
    );
  }

  if (!browser.hmrConnected) {
    notes.push(
      "Vite's HMR WebSocket did not connect through the proxy. Harmless for the benchmark — " +
        "nothing edits a running app mid-check — but it appears as a console error, so the " +
        "adapter must not count it against the application under test.",
    );
  }

  if (browser.failedRequests.length > 0) {
    notes.push(
      `${browser.failedRequests.length} request(s) failed while loading the page; the adapter ` +
        "records these per run rather than treating them as an infrastructure fault.",
    );
  }

  return {
    reachable: browser.scripted,
    firstServeMs: createMs + servedAt.elapsedMs,
    attempts: probes.length,
    neededRetries,
    adapterNotes: notes,
  };
}

export function formatSpikeReport(
  observations: PreviewSpikeObservations,
  verdict: PreviewSpikeVerdict,
): string {
  const { browser } = observations;
  const lines = [
    `Verdict: ${verdict.reachable ? "reachable" : "NOT reachable"}`,
    `Sandbox: ${observations.sandboxId}`,
    `Preview: ${observations.previewUrl}`,
    `Sandbox created in: ${observations.createMs}ms`,
    verdict.firstServeMs === undefined
      ? "First serve: never"
      : `First serve: ${verdict.firstServeMs}ms from cold, after ${verdict.attempts} probe(s)`,
    "",
    "Probes:",
    ...observations.probes.map(
      (probe) => `  ${probe.attempt}. +${probe.elapsedMs}ms ${probe.outcome} — ${probe.detail}`,
    ),
    "",
  ];

  if (browser === undefined) {
    lines.push("Browser: not run — nothing answered at the preview URL.");
  } else {
    lines.push(
      "Browser:",
      `  navigated in ${browser.gotoMs}ms`,
      `  app rendered: ${browser.appRenderedMs === undefined ? "never" : `${browser.appRenderedMs}ms`}`,
      `  title: ${browser.title}`,
      `  scripted the page: ${browser.scripted ? "yes" : "no"}`,
      `  HMR WebSocket: ${browser.hmrConnected ? "connected" : "did not connect"}`,
      `  console errors: ${browser.consoleErrors.length === 0 ? "none" : browser.consoleErrors.join("; ")}`,
      `  failed requests: ${browser.failedRequests.length === 0 ? "none" : browser.failedRequests.join("; ")}`,
    );
  }

  lines.push("", "For the adapter:", ...verdict.adapterNotes.map((note) => `  - ${note}`));

  return lines.join("\n");
}
