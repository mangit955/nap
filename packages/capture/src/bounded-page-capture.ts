/**
 * A `PageCapture` that lets only so many photographs happen at once.
 *
 * A worker runs many turns at a time and photographs every one that commits, so without this the
 * number of browsers open in a container is the worker's concurrency — a Chromium and its render
 * process each, about a gigabyte of images and a memory spike per page load. Five of those in one
 * pod is an OOMKill, and an OOMKill costs every turn in flight, not just the pictures.
 *
 * Queueing is free here in a way it would not be elsewhere: a thumbnail is best-effort and nobody
 * is waiting on it — the turn has already committed and the failure path is a log line — so a
 * capture that waits its turn costs a card that appears a few seconds later. See
 * `docs/scaling-design.md` §17 (B-6).
 *
 * The permit is taken *before* the inner capture starts, so the wait never eats the page's own
 * timeout: a queued capture gets the same deadline as one that ran immediately.
 */

import type {
  PageCapture,
  PageCaptureError,
  PageCaptureOptions,
} from "@nap/shared/ports/page-capture";
import type { Result } from "@nap/shared/result";

export type BoundedPageCaptureOptions = {
  /** How many captures may be in flight. Must be at least one, or nothing is ever photographed. */
  concurrency: number;
};

export class BoundedPageCapture implements PageCapture {
  readonly #inner: PageCapture;
  readonly #limit: number;
  #active = 0;
  /** Callers holding a place in the queue, resumed one per released permit, oldest first. */
  readonly #waiting: (() => void)[] = [];

  constructor(inner: PageCapture, options: BoundedPageCaptureOptions) {
    if (!Number.isInteger(options.concurrency) || options.concurrency < 1) {
      // Programmer error rather than a failed capture: a bound of nought is a deployment that
      // silently never photographs anything, which looks exactly like a browser that is broken.
      throw new RangeError("a capture bound below one photographs nothing");
    }

    this.#inner = inner;
    this.#limit = options.concurrency;
  }

  async capture(
    url: string,
    options?: PageCaptureOptions,
  ): Promise<Result<Uint8Array, PageCaptureError>> {
    await this.#acquire();
    try {
      return await this.#inner.capture(url, options);
    } finally {
      // In a `finally` because a throw from a browser adapter must not cost the permit — one
      // leaked permit at a bound of one is a worker that never photographs anything again.
      this.#release();
    }
  }

  async #acquire(): Promise<void> {
    if (this.#active < this.#limit) {
      this.#active += 1;
      return;
    }

    await new Promise<void>((resolve) => this.#waiting.push(resolve));
    // No increment: the permit was handed straight over rather than given back, for the reason
    // below.
  }

  #release(): void {
    // The permit passes to the next waiter without ever going back in the pool. Decrementing and
    // letting them re-acquire would open a window one microtask wide — the waiter resumes on a
    // microtask, and a fresh caller arriving in between would find the count under the limit and
    // take the same permit, putting two captures in flight at a bound of one.
    const next = this.#waiting.shift();
    if (next !== undefined) {
      next();
      return;
    }

    this.#active -= 1;
  }
}
