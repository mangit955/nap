/**
 * A `TurnRateLimiter` in the process, for tests and for compositions with no database.
 *
 * It is the same sliding window `PostgresTurnRateLimiter` implements, and the properties the port
 * describes hold here identically — the two are tested against the same assertions, because a fake
 * that admits a turn the real one refuses would make every route test above it a lie.
 *
 * What it cannot do is the reason the real one exists: one instance is one allowance, so two
 * processes holding one of these each grant the full allowance twice over.
 *
 * **The clock is a constructor argument**, which is what lets the window be tested by arithmetic
 * instead of by waiting or by mocking the clock globally. Proving the window *slides* means asking
 * what happens 59 and 61 minutes later, which is a thing to compute.
 */

import type { RateDecision, TurnRateLimiter } from "@nap/shared/ports/turn-rate-limit";

export type InMemoryRateLimit = {
  /** Turns allowed inside one window. */
  limit: number;
  windowMs: number;
  /** Defaults to the wall clock; tests pass one they can move. */
  now?: () => number;
};

export class InMemoryTurnRateLimiter implements TurnRateLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #recent = new Map<string, number[]>();

  constructor(limit: InMemoryRateLimit) {
    this.#limit = limit.limit;
    this.#windowMs = limit.windowMs;
    this.#now = limit.now ?? Date.now;
  }

  /** How many users are being tracked. Exposed so a test can assert the map does not grow. */
  get size(): number {
    return this.#recent.size;
  }

  async check(userId: string): Promise<RateDecision> {
    const now = this.#now();
    const cutoff = now - this.#windowMs;

    const kept = (this.#recent.get(userId) ?? []).filter((at) => at > cutoff);

    if (kept.length >= this.#limit) {
      // Refusals are not recorded, so what is stored is unchanged — but the pruning above is
      // still worth keeping, or a user permanently at their limit never sheds old timestamps.
      this.#store(userId, kept);

      const oldest = kept[0] ?? now;
      const freeAt = oldest + this.#windowMs;
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((freeAt - now) / 1000)) };
    }

    kept.push(now);
    this.#store(userId, kept);
    return { allowed: true };
  }

  async sweep(): Promise<number> {
    const cutoff = this.#now() - this.#windowMs;
    let dropped = 0;

    for (const [userId, timestamps] of this.#recent) {
      const kept = timestamps.filter((at) => at > cutoff);
      dropped += timestamps.length - kept.length;
      this.#store(userId, kept);
    }

    return dropped;
  }

  /** Drops the entry entirely when nothing is left, so idle users do not accumulate. */
  #store(userId: string, timestamps: number[]): void {
    if (timestamps.length === 0) this.#recent.delete(userId);
    else this.#recent.set(userId, timestamps);
  }
}
