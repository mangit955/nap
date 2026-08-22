import type {
  PageCapture,
  PageCaptureError,
  PageCaptureOptions,
} from "@nap/shared/ports/page-capture";
import type { Result } from "@nap/shared/result";
import { describe, expect, it, vi } from "vitest";
import { BoundedPageCapture } from "./bounded-page-capture.ts";

/**
 * The semaphore in front of the browser.
 *
 * `FakePageCapture` answers immediately, which makes it useless here: a bound is only observable
 * while something is *held*, so this needs captures that hang until the test lets them go. What is
 * asserted is the high-water mark of concurrent calls and nothing about pixels.
 */

/** A capture that never finishes until the test says so, counting how many are in flight. */
class HangingCapture implements PageCapture {
  #finish: (() => void)[] = [];
  active = 0;
  peak = 0;
  readonly urls: string[] = [];
  failure: Error | undefined;

  capture(
    url: string,
    _options?: PageCaptureOptions,
  ): Promise<Result<Uint8Array, PageCaptureError>> {
    this.urls.push(url);
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);

    if (this.failure !== undefined) {
      this.active -= 1;
      return Promise.reject(this.failure);
    }

    return new Promise((resolve) => {
      this.#finish.push(() => {
        this.active -= 1;
        resolve({ ok: true, value: new Uint8Array([1]) });
      });
    });
  }

  /** Ends the oldest capture still running. */
  finishOne(): void {
    this.#finish.shift()?.();
  }

  get pending(): number {
    return this.#finish.length;
  }
}

describe("bounding page capture", () => {
  it("runs one at a time at a bound of one", async () => {
    const inner = new HangingCapture();
    const capture = new BoundedPageCapture(inner, { concurrency: 1 });

    const all = [
      capture.capture("https://a.example/"),
      capture.capture("https://b.example/"),
      capture.capture("https://c.example/"),
    ];

    await vi.waitFor(() => expect(inner.active).toBe(1));
    // Long enough for the other two to have started if nothing were stopping them.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(inner.peak).toBe(1);
    expect(inner.urls).toEqual(["https://a.example/"]);

    inner.finishOne();
    await vi.waitFor(() => expect(inner.urls).toHaveLength(2));

    inner.finishOne();
    await vi.waitFor(() => expect(inner.urls).toHaveLength(3));
    inner.finishOne();

    const results = await Promise.all(all);
    expect(results.every((result) => result.ok)).toBe(true);
    // Never two at once at any point, which is the whole property: the peak, not the final count.
    expect(inner.peak).toBe(1);
  });

  it("lets the bound's worth through at once, and no more", async () => {
    const inner = new HangingCapture();
    const capture = new BoundedPageCapture(inner, { concurrency: 2 });

    const all = [
      capture.capture("https://a.example/"),
      capture.capture("https://b.example/"),
      capture.capture("https://c.example/"),
    ];

    await vi.waitFor(() => expect(inner.active).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(inner.peak).toBe(2);

    inner.finishOne();
    await vi.waitFor(() => expect(inner.urls).toHaveLength(3));
    inner.finishOne();
    inner.finishOne();
    await Promise.all(all);
    expect(inner.peak).toBe(2);
  });

  it("gives the permit back when a capture throws", async () => {
    // A browser adapter that rejects rather than answering a failed `Result` is a bug, but one
    // leaked permit at a bound of one is a worker that never photographs anything again — so the
    // release cannot depend on the inner call being well behaved.
    const inner = new HangingCapture();
    inner.failure = new Error("the browser died");
    const capture = new BoundedPageCapture(inner, { concurrency: 1 });

    await expect(capture.capture("https://a.example/")).rejects.toThrow("the browser died");

    inner.failure = undefined;
    const second = capture.capture("https://b.example/");
    await vi.waitFor(() => expect(inner.active).toBe(1));
    inner.finishOne();
    await expect(second).resolves.toMatchObject({ ok: true });
  });

  it("refuses a bound that would photograph nothing", () => {
    const inner = new HangingCapture();

    // A deployment set to zero would look exactly like a browser that is broken, forever.
    expect(() => new BoundedPageCapture(inner, { concurrency: 0 })).toThrow(RangeError);
    expect(() => new BoundedPageCapture(inner, { concurrency: 1.5 })).toThrow(RangeError);
  });
});
