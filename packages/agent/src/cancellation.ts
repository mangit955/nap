/**
 * Racing work against a turn's cancellation.
 *
 * The provider receives the signal too, but a proxy or upstream stream can take a while to
 * honour it. Racing here ends the waiting immediately, preventing further tool calls or streamed
 * output while the transport tears itself down in the background.
 */

export const CANCELLED = Symbol("cancelled");

/** Resolves promptly on abort even if an upstream streaming request is slow to settle. */
export function stopAware<T>(
  work: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T | typeof CANCELLED> {
  if (signal === undefined) return work;
  if (signal.aborted) return Promise.resolve(CANCELLED);

  return new Promise((resolve, reject) => {
    const stopped = () => resolve(CANCELLED);
    signal.addEventListener("abort", stopped, { once: true });
    void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", stopped));
  });
}

/** Waits, unless the signal says stop first. Returns whether the full wait elapsed. */
export function pause(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", stop);
      resolve(true);
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener("abort", stop, { once: true });
  });
}
