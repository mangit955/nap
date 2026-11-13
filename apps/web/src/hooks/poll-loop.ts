/**
 * A read repeated on a timer, which stops asking while nobody can see the answer.
 *
 * The workspace keeps a few questions open against the API for as long as it is mounted — is this
 * session busy, has that publication finished — and a plain one-second interval asks them in a
 * background tab, in a window behind three others, and in an idle session where the answer has
 * not changed in an hour. This is the one place those loops get three rules right:
 *
 * - **One read at a time, and the read decides the wait.** The next delay is whatever the read
 *   returns, so a caller can ask quickly while work is running and slowly once it is not, from
 *   the answer it just got rather than from state that has not rendered yet.
 * - **Parked while the page is hidden.** No timer runs at all. Becoming visible reads at once,
 *   since whatever changed while hidden is exactly what the person came back to see; so does the
 *   window regaining focus, which is how a second window or another device's work gets noticed.
 * - **`soon` only ever brings the next read forward.** A caller nudging the loop on every
 *   streamed event must not postpone a read that was about to happen — a nudge that restarted the
 *   wait would starve the loop for as long as events kept arriving.
 *
 * A read in flight is never doubled: a nudge, focus or visibility change during one is dropped,
 * because the read that is running will answer it and schedule the next. Cancelling a read is
 * the caller's — it owns the `AbortController` — and `stop` only promises that nothing runs again.
 */
export type PollLoop = {
  /** Read within `withinMs` from now, unless a read is already due sooner or running. */
  soon: (withinMs: number) => void;
  /** Clears the timer and the listeners. A read still in flight schedules nothing. */
  stop: () => void;
};

export function startPollLoop(options: {
  /** Resolves to how long to wait before the next read. A rejection waits `firstDelayMs`. */
  read: () => Promise<number>;
  /** Before the first read, and after a read that threw. */
  firstDelayMs: number;
}): PollLoop {
  const { read, firstDelayMs } = options;
  let stopped = false;
  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  // When the scheduled read will run; Infinity while parked or between reads.
  let dueAt = Number.POSITIVE_INFINITY;

  const hidden = () => document.visibilityState === "hidden";

  const schedule = (delayMs: number) => {
    clearTimeout(timer);
    timer = undefined;
    dueAt = Number.POSITIVE_INFINITY;
    // Parked: the visibility listener is what starts it again.
    if (stopped || hidden()) return;
    dueAt = Date.now() + delayMs;
    timer = setTimeout(() => void run(), delayMs);
  };

  const run = async () => {
    timer = undefined;
    dueAt = Number.POSITIVE_INFINITY;
    if (stopped) return;
    if (hidden()) return;
    inFlight = true;
    let next = firstDelayMs;
    try {
      next = await read();
    } catch {
      // The caller's read handles its own failures; this only keeps the loop alive if it did not.
    } finally {
      inFlight = false;
    }
    schedule(next);
  };

  const soon = (withinMs: number) => {
    if (stopped || inFlight) return;
    if (Date.now() + withinMs < dueAt) schedule(withinMs);
  };

  const now = () => soon(0);
  const onVisibility = () => {
    if (!hidden()) now();
  };

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("focus", now);
  schedule(firstDelayMs);

  return {
    soon,
    stop: () => {
      stopped = true;
      clearTimeout(timer);
      timer = undefined;
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("focus", now);
    },
  };
}
