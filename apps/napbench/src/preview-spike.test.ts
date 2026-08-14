import { describe, expect, it } from "vitest";
import {
  type BrowserFindings,
  formatSpikeReport,
  PREVIEW_SPIKE_DEFAULTS,
  type PreviewSpikeObservations,
  parsePreviewSpikeArgs,
  summarisePreviewSpike,
} from "./preview-spike.ts";

function options(argv: string[]) {
  const parsed = parsePreviewSpikeArgs(argv);
  if (!parsed.ok) throw new Error(`expected a parse, got: ${parsed.error}`);
  return parsed.value;
}

describe("parsePreviewSpikeArgs", () => {
  it("defaults to a dry run, because this one spends money", () => {
    expect(options([]).real).toBe(false);
  });

  it("spends only when told to, explicitly", () => {
    expect(options(["--real"]).real).toBe(true);
  });

  it("destroys the sandbox unless asked to keep it", () => {
    expect(options([]).keep).toBe(false);
    expect(options(["--keep"]).keep).toBe(true);
  });

  it("takes the deadlines from the command line", () => {
    expect(options(["--timeout=45000"]).timeoutMs).toBe(45_000);
    expect(options(["--poll=250"]).pollMs).toBe(250);
    expect(options([]).timeoutMs).toBe(PREVIEW_SPIKE_DEFAULTS.timeoutMs);
  });

  it("refuses an unknown flag rather than ignoring it", () => {
    // The forgiving version of this parser lets `--rael` mean "dry run" on the day
    // somebody meant to spend, and `--timout=` silently use the default on the day they
    // meant to wait longer.
    const parsed = parsePreviewSpikeArgs(["--rael"]);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("--rael");
  });

  it("refuses a deadline that is not a positive number", () => {
    expect(parsePreviewSpikeArgs(["--timeout=nope"]).ok).toBe(false);
    expect(parsePreviewSpikeArgs(["--poll=0"]).ok).toBe(false);
  });

  it("refuses a bare positional argument", () => {
    // This script takes no prompt. A stray word is far likelier to be a mistyped flag.
    expect(parsePreviewSpikeArgs(["sandbox"]).ok).toBe(false);
  });
});

const drivable: BrowserFindings = {
  gotoMs: 800,
  appRenderedMs: 1_100,
  title: "Nap app",
  scripted: true,
  clickTested: true,
  consoleErrors: [],
  failedRequests: [],
  hmrSocket: "opened",
};

const served: PreviewSpikeObservations = {
  sandboxId: "sbx_1",
  previewUrl: "https://5173-sbx1.e2b.app",
  createMs: 900,
  probes: [
    { attempt: 1, elapsedMs: 120, outcome: "error", detail: "fetch failed" },
    { attempt: 2, elapsedMs: 1_300, outcome: "status", detail: "HTTP 502" },
    { attempt: 3, elapsedMs: 2_450, outcome: "ok", detail: "HTTP 200" },
  ],
  browser: drivable,
};

describe("summarisePreviewSpike", () => {
  it("calls a preview that answered reachable, and times it from cold", () => {
    const verdict = summarisePreviewSpike(served);
    expect(verdict.reachable).toBe(true);
    // From sandbox creation, not from the first probe: what an adapter has to budget for
    // is the whole cold start, and the sandbox is part of it.
    expect(verdict.firstServeMs).toBe(900 + 2_450);
    expect(verdict.attempts).toBe(3);
  });

  it("reports that retries were needed when the first probe missed", () => {
    const verdict = summarisePreviewSpike(served);
    expect(verdict.neededRetries).toBe(true);
    expect(verdict.adapterNotes.join(" ")).toContain("poll");
  });

  it("reports no retries when the first probe served", () => {
    const verdict = summarisePreviewSpike({
      ...served,
      probes: [{ attempt: 1, elapsedMs: 200, outcome: "ok", detail: "HTTP 200" }],
    });
    expect(verdict.neededRetries).toBe(false);
  });

  it("is unreachable when no probe ever served, and says so as the blocking answer", () => {
    const verdict = summarisePreviewSpike({
      ...served,
      probes: [{ attempt: 1, elapsedMs: 120, outcome: "error", detail: "fetch failed" }],
      browser: undefined,
    });
    expect(verdict.reachable).toBe(false);
    expect(verdict.firstServeMs).toBeUndefined();
    expect(verdict.adapterNotes.join(" ")).toContain("blocked");
  });

  it("is not reachable-for-our-purposes when HTTP served but the browser could not script it", () => {
    // The binary question is about a *browser*, not an HTTP client. A proxy that answers
    // fetch but breaks scripting would fail every browser check in the benchmark while
    // looking fine to `waitForPreview`.
    const verdict = summarisePreviewSpike({
      ...served,
      browser: { ...drivable, scripted: false },
    });
    expect(verdict.reachable).toBe(false);
    expect(verdict.adapterNotes.join(" ")).toContain("script");
  });

  it("does not let console errors in the generated app count against reachability", () => {
    // A page that throws is the *app's* problem, and the benchmark scores it. It says
    // nothing about whether the proxy works.
    const verdict = summarisePreviewSpike({
      ...served,
      browser: { ...drivable, consoleErrors: ["TypeError: x is not a function"] },
    });
    expect(verdict.reachable).toBe(true);
  });

  it("notes an errored HMR socket without treating it as a failure", () => {
    const verdict = summarisePreviewSpike({
      ...served,
      browser: { ...drivable, hmrSocket: "errored" },
    });
    expect(verdict.reachable).toBe(true);
    expect(verdict.adapterNotes.join(" ")).toContain("WebSocket");
  });

  it("keeps an app that never rendered apart from a proxy that never worked", () => {
    // The whole point of the spike: reachability is a fact about the proxy. An app that
    // renders nothing while the browser drives it fine is the benchmark's subject, not an
    // infrastructure fault, and scoring it as one would blame E2B for every broken app.
    const verdict = summarisePreviewSpike({
      ...served,
      browser: { ...drivable, appRenderedMs: undefined },
    });
    expect(verdict.reachable).toBe(true);
    expect(verdict.adapterNotes.join(" ")).toContain("application's problem");
  });

  it("tells the adapter to filter the favicon 404 it will see on every single run", () => {
    // Measured, not guessed: the template declares no icon and has no public/ directory, so
    // Chrome's automatic request 404s against every app the benchmark will ever run.
    const verdict = summarisePreviewSpike({
      ...served,
      browser: { ...drivable, consoleErrors: ["Failed to load resource: ... 404 ()"] },
    });
    expect(verdict.adapterNotes.join(" ")).toContain("favicon");
  });
});

describe("formatSpikeReport", () => {
  it("does not report a click that was never attempted", () => {
    const observations = { ...served, browser: { ...drivable, clickTested: false } };
    const report = formatSpikeReport(observations, summarisePreviewSpike(observations));
    expect(report).toContain("not tested");
  });

  it("states the render cost relative to load, not as an independent number", () => {
    // Both are timed from the same start, so reading them as independent inverts the
    // conclusion about what the slow part is.
    const report = formatSpikeReport(served, summarisePreviewSpike(served));
    expect(report).toContain("300ms after DOMContentLoaded");
  });

  it("states the verdict, the timings and every probe", () => {
    const report = formatSpikeReport(served, summarisePreviewSpike(served));
    expect(report).toContain("reachable");
    expect(report).toContain("HTTP 502");
    expect(report).toContain("3350ms");
  });

  it("reports the browser as not run when there was nothing to load", () => {
    const observations = { ...served, browser: undefined };
    const report = formatSpikeReport(observations, summarisePreviewSpike(observations));
    expect(report).toContain("not run");
  });
});
