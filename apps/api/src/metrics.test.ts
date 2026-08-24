import { describe, expect, it } from "vitest";
import { createMetrics, METRICS_CONTENT_TYPE, WS_CONNECTIONS_METRIC } from "./metrics.ts";

/**
 * The gauge the API's autoscaler reads.
 *
 * Every assertion here is about a way the number could be wrong without anything failing: a
 * socket counted twice on the way out, a gauge that drifts below zero and then never rises past
 * the threshold again, a body Prometheus cannot parse. None of those produce an error anywhere —
 * they produce a deployment that scales on a lie.
 */
describe("createMetrics", () => {
  it("starts at zero, and says so rather than omitting the series", () => {
    // A missing series is not a zero: prometheus-adapter reports the metric as unavailable, and
    // an HPA with an unavailable metric falls back to its other trigger. A pod holding no
    // sockets has to be readable as holding none.
    expect(createMetrics().render()).toContain(`${WS_CONNECTIONS_METRIC} 0`);
  });

  it("counts open streams up and down", () => {
    const metrics = createMetrics();
    const first = metrics.connectionOpened();
    metrics.connectionOpened();
    expect(metrics.wsConnections()).toBe(2);

    first();
    expect(metrics.wsConnections()).toBe(1);
  });

  it("ignores a second close of the same stream", () => {
    // `/ws` calls its close handler on error *and* on close, so the same socket routinely ends
    // twice. Counting both would walk the gauge down towards zero while pods were still full.
    const metrics = createMetrics();
    const close = metrics.connectionOpened();
    close();
    close();
    expect(metrics.wsConnections()).toBe(0);
  });

  it("renders the Prometheus exposition format, with a HELP and a TYPE line", () => {
    const metrics = createMetrics();
    metrics.connectionOpened();

    const body = metrics.render();
    expect(body).toMatch(new RegExp(`^# HELP ${WS_CONNECTIONS_METRIC} .+$`, "m"));
    expect(body).toMatch(new RegExp(`^# TYPE ${WS_CONNECTIONS_METRIC} gauge$`, "m"));
    expect(body).toMatch(new RegExp(`^${WS_CONNECTIONS_METRIC} 1$`, "m"));
    // A body without a trailing newline is a parse error in some scrapers, and reported as a
    // scrape failure rather than as a malformed metric.
    expect(body.endsWith("\n")).toBe(true);
  });

  it("names a content type a scraper accepts", () => {
    expect(METRICS_CONTENT_TYPE).toContain("text/plain");
    expect(METRICS_CONTENT_TYPE).toContain("version=0.0.4");
  });
});
