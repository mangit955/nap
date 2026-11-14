/**
 * What the model is writing, on its way from a token stream to the event log.
 *
 * Two things arrive this way — its summarized reasoning and the prose of its answer — and both
 * come a few characters at a time, dozens of times a second. Every event this repo produces is
 * a durable row, appended and then fanned out, so forwarding each delta as its own event would
 * write thousands of rows for one turn. Buffering them into phrase-sized pieces costs a
 * fraction of a second of latency and turns that into a few dozen rows, which is what makes
 * the stream something a client can replay after a reload rather than something it had to be
 * watching for.
 *
 * Two thresholds, because either one alone has a failure: characters alone leaves a short
 * closing phrase sitting in the buffer until the next burst arrives, and time alone chops a
 * fast burst into whatever landed in each window. Whichever comes first wins.
 *
 * **The time threshold is a timer, not a check made when the next delta lands.** It used to be
 * the second, and a short preamble — "Let me build the board." — then waited for the whole
 * response: the model went on to stream a tool call's arguments, which are not text, so
 * nothing pushed again until the call returned, seconds or tens of seconds later.
 *
 * A stream belongs to one model call and is ended with it, by `close` (hand over the tail) or
 * `abandon` (the turn was cancelled; drop it). After either it is inert: no timer is left
 * armed, and a delta from a transport still tearing itself down is ignored, so nothing can
 * reach the log after the step that owned it is over.
 *
 * The thresholds are a parameter because command output takes the same path for the same
 * reason and wants different numbers: it arrives in lines rather than tokens, nobody reads it
 * phrase by phrase, and a build prints thousands of lines. See `tools/output-stream.ts`.
 *
 * The scheduler is injected, so the interesting cases — a tail below both thresholds, a delta
 * that overshoots one, a window that closes with nothing else arriving, a stream ended with a
 * timer armed — are testable without a model, without waiting, and without fake global timers.
 */

/** Roughly a phrase. Short enough to read as it arrives, long enough not to spam the log. */
export const FLUSH_AFTER_CHARS = 120;

/**
 * How long buffered text may wait before it is shown. Slow enough that a burst arrives in
 * one piece, fast enough that a pause between thoughts still puts something on screen.
 *
 * Measured from the moment text first enters the buffer, **not** from when the stream was
 * built. A model takes seconds to produce its first token, so a window opened at
 * construction has already expired when that token lands — and every message would begin
 * with a lone character sitting on its own line. That is not hypothetical: it is what the
 * first real turn printed.
 */
export const FLUSH_AFTER_MS = 400;

/** Runs `run` after `ms`, and returns what cancels it. */
export type Schedule = (run: () => void, ms: number) => () => void;

/** When a buffer is handed over: at `chars`, or `ms` after text first entered it. */
export type FlushThresholds = { chars: number; ms: number };

export const realTimers: Schedule = (run, ms) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

export class DeltaStream {
  readonly #emit: (text: string) => void;
  readonly #schedule: Schedule;
  readonly #thresholds: FlushThresholds;
  #buffer = "";
  /** Cancels the window the buffered text opened. Undefined whenever the buffer is empty. */
  #disarm: (() => void) | undefined;
  #ended = false;

  constructor(
    emit: (text: string) => void,
    schedule: Schedule = realTimers,
    thresholds: FlushThresholds = { chars: FLUSH_AFTER_CHARS, ms: FLUSH_AFTER_MS },
  ) {
    this.#emit = emit;
    this.#schedule = schedule;
    this.#thresholds = thresholds;
  }

  push(delta: string): void {
    if (this.#ended || delta === "") return;
    this.#buffer += delta;

    if (this.#buffer.length >= this.#thresholds.chars) {
      this.flush();
      return;
    }
    // Opened by the first text into an empty buffer and closed with it, which is what keeps a
    // long silence *before* the text from expiring the window in advance.
    this.#disarm ??= this.#schedule(() => {
      this.#disarm = undefined;
      this.flush();
    }, this.#thresholds.ms);
  }

  /**
   * Hands over whatever is buffered, if anything, and closes its window.
   *
   * Called mid-call wherever order demands it — a tool call starting, the other channel
   * speaking — and deliberately silent on an empty buffer, since a turn that thought nothing
   * would otherwise put an empty paragraph on the rail.
   */
  flush(): void {
    this.#disarm?.();
    this.#disarm = undefined;
    // Nothing to check for an ended stream: ending empties the buffer and `push` refuses
    // anything after, so an ended stream has nothing here to hand over.
    if (this.#buffer === "") return;

    const text = this.#buffer;
    this.#buffer = "";
    this.#emit(text);
  }

  /** The call is over: hands over the tail, so a thought below both thresholds is not lost. */
  close(): void {
    this.flush();
    this.#ended = true;
  }

  /** The call was cancelled: drops the tail, since nothing may follow the turn's ending. */
  abandon(): void {
    this.#disarm?.();
    this.#disarm = undefined;
    this.#buffer = "";
    this.#ended = true;
  }
}
