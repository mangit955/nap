/**
 * How often one person may start a turn.
 *
 * Every turn is a real model call and a real sandbox billed by the second, so an unbounded
 * endpoint is an unbounded bill — reachable by a loop in a browser tab as easily as by malice.
 *
 * **A sliding window, not a fixed one.** A fixed window is simpler and wrong twice: someone can
 * spend a full allowance either side of a boundary, taking double the limit in a moment, and it
 * cannot answer the question `Retry-After` asks. Keeping the timestamps means the answer is
 * exact — the oldest one leaving the window is precisely when a slot opens.
 *
 * **A refused attempt costs nothing.** Recording it would push a retrying client's recovery
 * further away with every attempt, so the time it was told to wait would never arrive.
 *
 * Per process, like `TurnRegistry` beside it, and for the same reason: v1 runs one instance. A
 * second one would grant each replica the full allowance, and the honest fix is a shared counter
 * rather than a cleverer map. The failure mode is a limit that is too generous, not one that
 * refuses the wrong person.
 */

export type RateLimit = {
  /** Turns allowed inside one window. */
  limit: number;
  windowMs: number;
};

export type RateDecision =
  | { allowed: true }
  /** Whole seconds, and never zero — `Retry-After: 0` invites an immediate, futile retry. */
  | { allowed: false; retryAfterSeconds: number };

export class TurnRateLimiter {
  readonly #limit: RateLimit;
  readonly #recent = new Map<string, number[]>();
  #sweptAt = Number.NEGATIVE_INFINITY;

  constructor(limit: RateLimit) {
    this.#limit = limit;
  }

  /** How many users are being tracked. Exposed so a test can assert the map does not grow. */
  get size(): number {
    return this.#recent.size;
  }

  /**
   * Whether this user may start a turn now, recording it if so.
   *
   * `now` is a parameter rather than a call to `Date.now()`, which is what lets the window be
   * tested by arithmetic instead of by waiting or by mocking the clock globally.
   */
  check(userId: string, now: number): RateDecision {
    const cutoff = now - this.#limit.windowMs;
    this.#sweep(now, cutoff);

    const kept = (this.#recent.get(userId) ?? []).filter((at) => at > cutoff);

    if (kept.length >= this.#limit.limit) {
      // Refusals are not recorded, so what is stored is unchanged — but the pruning above is
      // still worth keeping, or a user permanently at their limit never sheds old timestamps.
      this.#store(userId, kept);

      const oldest = kept[0] ?? now;
      const freeAt = oldest + this.#limit.windowMs;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((freeAt - now) / 1000)) };
    }

    kept.push(now);
    this.#store(userId, kept);
    return { allowed: true };
  }

  /** Drops the entry entirely when nothing is left, so idle users do not accumulate. */
  #store(userId: string, timestamps: number[]): void {
    if (timestamps.length === 0) this.#recent.delete(userId);
    else this.#recent.set(userId, timestamps);
  }

  /**
   * Drops every user whose timestamps have all expired.
   *
   * Pruning only the user being checked is not enough: somebody who sends one message and never
   * returns keeps an entry forever, so a public deployment accumulates one per visitor. Run at
   * most once per window, which makes it free in amortised terms — the alternative, a timer,
   * would mean this class owning a handle somebody has to remember to clear.
   */
  #sweep(now: number, cutoff: number): void {
    if (now - this.#sweptAt < this.#limit.windowMs) return;
    this.#sweptAt = now;

    for (const [userId, timestamps] of this.#recent) {
      if (timestamps.every((at) => at <= cutoff)) this.#recent.delete(userId);
    }
  }
}
