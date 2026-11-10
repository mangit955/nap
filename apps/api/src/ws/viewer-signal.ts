/**
 * One connection's "somebody is looking", rate-limited before it reaches the database.
 *
 * The store's statement already throttles per project, across every tab on every pod. That bounds
 * the writes, but not the queries: each frame would still be a round trip, and a client sending
 * them in a loop would be one socket hammering Postgres. So each connection forwards at most one
 * signal an interval, and drops the rest here, where it costs nothing.
 *
 * A failed write is reported rather than retried. Losing one costs, at worst, a sandbox reaped a
 * tick early — the restore this exists to avoid, not data — and the next signal comes in a minute.
 */

export type ViewerSignalOptions = {
  record: () => Promise<void>;
  intervalMs: number;
  onError: (error: unknown) => void;
  now?: () => number;
};

export function viewerSignal(options: ViewerSignalOptions): () => void {
  const now = options.now ?? Date.now;
  let lastAt: number | undefined;
  return () => {
    const at = now();
    if (lastAt !== undefined && at - lastAt < options.intervalMs) return;
    lastAt = at;
    options.record().catch(options.onError);
  };
}
