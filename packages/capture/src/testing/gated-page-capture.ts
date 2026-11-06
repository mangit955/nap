/**
 * A `PageCapture` whose photographs finish when the test says so.
 *
 * The questions asked of the thumbnail lane are all about what happens *while* a browser is open:
 * whether the lease has gone, how many are running, what a shutdown does. A capture that answered
 * at once would make a lane that waited look identical to one that does not.
 */

import type {
  PageCapture,
  PageCaptureError,
  PageCaptureOptions,
} from "@nap/shared/ports/page-capture";
import type { Result } from "@nap/shared/result";

type Answer = Result<Uint8Array, PageCaptureError>;

export class GatedPageCapture implements PageCapture {
  /** Every capture asked for, in order, including the ones already answered. */
  readonly requests: { url: string; options: PageCaptureOptions }[] = [];
  readonly #open: ((answer: Answer) => void)[] = [];
  /** The most that were ever open at once, which is what a concurrency bound is asserted on. */
  peak = 0;

  /** How many are open right now. */
  get waiting(): number {
    return this.#open.length;
  }

  capture(url: string, options: PageCaptureOptions = {}): Promise<Answer> {
    this.requests.push({ url, options });
    return new Promise((resolve) => {
      this.#open.push(resolve);
      this.peak = Math.max(this.peak, this.#open.length);
    });
  }

  /** Finishes the oldest open capture, with these bytes. */
  release(bytes: Uint8Array = new Uint8Array([137, 80, 78, 71])): void {
    this.#open.shift()?.({ ok: true, value: bytes });
  }

  /** Finishes the oldest open capture as a failure. */
  fail(error: PageCaptureError): void {
    this.#open.shift()?.({ ok: false, error });
  }

  /** Finishes everything, for a test's teardown: nothing may be left pending behind it. */
  releaseAll(): void {
    while (this.#open.length > 0) this.release();
  }
}
