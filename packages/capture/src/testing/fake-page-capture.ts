/**
 * A `PageCapture` that photographs nothing and remembers everything.
 *
 * Every test above this port cares about two things only: which address was asked for, and what
 * the caller does when the answer is a failure. Neither needs a browser, and a suite that
 * launched one would stop being free, offline and deterministic in one step.
 *
 * `failWith` is what makes the guard testable — a turn must survive a capture that fails, and
 * there is no other way to produce that on demand.
 */

import type {
  PageCapture,
  PageCaptureError,
  PageCaptureOptions,
} from "@nap/shared/ports/page-capture";
import type { Result } from "@nap/shared/result";

/** Not a real PNG, and deliberately: nothing above the port may inspect the pixels. */
const DEFAULT_BYTES = new Uint8Array([137, 80, 78, 71]);

export class FakePageCapture implements PageCapture {
  #failure: PageCaptureError | undefined;
  #bytes: Uint8Array = DEFAULT_BYTES;

  /** Every capture asked for, in order, so a test can assert on the address and the size. */
  readonly requests: { url: string; options: PageCaptureOptions }[] = [];

  /** Makes every capture fail until called again with `undefined`. */
  failWith(error: PageCaptureError | undefined): this {
    this.#failure = error;
    return this;
  }

  /** What a successful capture hands back, for a test that follows the bytes to storage. */
  returning(bytes: Uint8Array): this {
    this.#bytes = bytes;
    return this;
  }

  async capture(
    url: string,
    options: PageCaptureOptions = {},
  ): Promise<Result<Uint8Array, PageCaptureError>> {
    this.requests.push({ url, options });
    if (this.#failure !== undefined) return { ok: false, error: this.#failure };

    // Copied, like the object store's fake: a caller free to reuse its buffer against a real
    // implementation must not be able to corrupt this one.
    return { ok: true, value: Uint8Array.from(this.#bytes) };
  }
}
