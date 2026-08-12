/**
 * The model's summarized reasoning, on its way from a token stream to the event log.
 *
 * The model emits reasoning a few characters at a time, dozens of times a second. Every event
 * this repo produces is a durable row, appended and then fanned out — so forwarding each delta
 * as its own event would write thousands of rows for one turn's thinking and answer the same
 * question a hundred times over. Buffering them into phrase-sized pieces costs a fraction of a
 * second of latency and turns that into a few dozen rows, which is what makes the reasoning
 * something a client can replay after a reload rather than something it had to be watching for.
 *
 * Two thresholds, because either one alone has a failure: characters alone leaves a short
 * closing thought sitting in the buffer until the next burst arrives, and time alone chops a
 * fast burst into whatever landed in each window. Whichever comes first wins.
 *
 * Pure, with an injected clock, so the interesting cases — a tail below both thresholds, a
 * delta that overshoots one, a flush with nothing buffered — are testable without a model and
 * without waiting.
 */

/** Roughly a phrase. Short enough to read as it arrives, long enough not to spam the log. */
export const FLUSH_AFTER_CHARS = 120;

/**
 * Slow enough that a burst arrives in one piece, fast enough that a pause between thoughts
 * still puts something on screen.
 */
export const FLUSH_AFTER_MS = 400;

export class ThinkingStream {
  readonly #emit: (text: string) => void;
  readonly #now: () => number;
  #buffer = "";
  #lastFlushedAt: number;

  constructor(emit: (text: string) => void, now: () => number = () => Date.now()) {
    this.#emit = emit;
    this.#now = now;
    this.#lastFlushedAt = now();
  }

  push(delta: string): void {
    if (delta === "") return;
    this.#buffer += delta;

    if (
      this.#buffer.length >= FLUSH_AFTER_CHARS ||
      this.#now() - this.#lastFlushedAt >= FLUSH_AFTER_MS
    ) {
      this.flush();
    }
  }

  /**
   * Hands over whatever is buffered, if anything.
   *
   * Called when the model call returns, so a thought that ended below both thresholds is not
   * lost — and deliberately silent on an empty buffer, since a turn that thought nothing would
   * otherwise put an empty paragraph on the rail.
   */
  flush(): void {
    // The timestamp moves even with nothing to send: the window measures time since the last
    // decision, and leaving it behind would make the next delta flush on its own.
    this.#lastFlushedAt = this.#now();
    if (this.#buffer === "") return;

    const text = this.#buffer;
    this.#buffer = "";
    this.#emit(text);
  }
}
