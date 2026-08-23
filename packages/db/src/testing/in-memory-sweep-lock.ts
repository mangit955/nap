/**
 * The sweep lock in one process, for tests of everything that sits *on* it.
 *
 * It cannot prove what the Postgres one is for — that a second *connection* is refused — and does
 * not try; `postgres-advisory-lock.db.test.ts` owns that. What it is for is the composition: two
 * reaper compositions built in one test, one of which must sweep nothing.
 *
 * `contender()` is how the second one is made, because the interesting arrangement is two lock
 * objects over one key and a constructor argument would let a test accidentally hand both
 * compositions the same object — which would make every `held()` true and the test pass for the
 * wrong reason.
 */

import type { SweepLock } from "@nap/shared/ports/sweep-lock";

/** The single thing the contenders contend over. */
type Key = { holder: InMemorySweepLock | null };

export class InMemorySweepLock implements SweepLock {
  readonly #key: Key;

  constructor(key: Key = { holder: null }) {
    this.#key = key;
  }

  /** Another process asking for the same lock. */
  contender(): InMemorySweepLock {
    return new InMemorySweepLock(this.#key);
  }

  async held(): Promise<boolean> {
    this.#key.holder ??= this;
    return this.#key.holder === this;
  }

  async release(): Promise<void> {
    if (this.#key.holder === this) this.#key.holder = null;
  }
}
