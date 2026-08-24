/**
 * What this pod is holding, in the one format an autoscaler can read.
 *
 * There is exactly one series here and it is the one CPU cannot stand in for: an open WebSocket
 * costs a file descriptor, a subscription and a heartbeat timer, so several hundred of them can
 * sit on a pod at near-zero CPU while it is at its practical limit. `infra/k8s/base/hpa-api.yaml`
 * scales on this gauge first and on CPU second, which only works if something exports it.
 *
 * Deliberately hand-rolled rather than a Prometheus client library. The exposition format for one
 * gauge is four lines; a dependency would bring a default registry of process metrics nobody
 * reads, a second way of naming things, and a scrape surface wider than the one number the
 * deployment scales on. When there is a second metric with labels, that trade changes.
 */

/** The series name, shared with the HPA that reads it — `test/k8s.test.ts` checks they agree. */
export const WS_CONNECTIONS_METRIC = "nap_ws_connections";

/**
 * The version Prometheus's own text parser announces. A scraper that receives no version
 * negotiates down to it anyway; saying it means a proxy in between cannot guess wrong.
 */
export const METRICS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8";

export type Metrics = {
  /**
   * Records a stream opening, and hands back the one way to record it closing.
   *
   * A closure rather than a `connectionClosed()` on the object, because `/ws` ends a socket from
   * two places — `onClose` and `onError`, and an errored socket reaches both. A shared decrement
   * would count that socket out twice and walk the gauge below the pods' real load, which is a
   * cluster that scales in while it is full. This one is idempotent per stream.
   */
  connectionOpened(): () => void;
  /** The current count, for tests and for whoever is reading rather than scraping. */
  wsConnections(): number;
  /** The whole scrape body, Prometheus exposition format, newline-terminated. */
  render(): string;
};

export function createMetrics(): Metrics {
  let open = 0;

  return {
    connectionOpened() {
      open += 1;
      let closed = false;
      return () => {
        if (closed) return;
        closed = true;
        open -= 1;
      };
    },
    wsConnections: () => open,
    render: () =>
      [
        `# HELP ${WS_CONNECTIONS_METRIC} Open WebSocket event streams held by this pod.`,
        `# TYPE ${WS_CONNECTIONS_METRIC} gauge`,
        `${WS_CONNECTIONS_METRIC} ${open}`,
        "",
      ].join("\n"),
  };
}
