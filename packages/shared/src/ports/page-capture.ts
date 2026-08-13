/**
 * A picture of a page that is currently being served.
 *
 * The dashboard shows each project as the app it actually is, which means something has to
 * render one. That something is a browser, and a browser is the heaviest dependency in this
 * system — so it sits behind an interface for the same reason E2B and the S3 client do:
 * nothing above this line may know whether the pixels came from headless Chrome, a hosted
 * screenshot service, or a fake handing back four bytes.
 *
 * **The URL must already be serving.** This takes an address and photographs whatever answers
 * at it; waiting for a dev server to come up belongs to whoever owns the sandbox.
 *
 * Failures are values, as on every other port here. A page that will not load is an ordinary
 * outcome — the sandbox may have been reclaimed mid-turn — and a caller that would otherwise
 * upload an empty file as a thumbnail should fail to compile if it forgets to check.
 */

import type { Result } from "../result.ts";

export type PageCaptureErrorCode =
  /** No browser to drive, or it died. Distinct from the page itself being slow. */
  | "unavailable"
  /** The page did not finish loading inside the deadline. */
  | "timeout";

export type PageCaptureError = {
  code: PageCaptureErrorCode;
  message: string;
};

export type PageCaptureOptions = {
  width?: number;
  height?: number;
  timeoutMs?: number;
};

export interface PageCapture {
  /** PNG bytes of `url` rendered at the given viewport. */
  capture(url: string, options?: PageCaptureOptions): Promise<Result<Uint8Array, PageCaptureError>>;
}
