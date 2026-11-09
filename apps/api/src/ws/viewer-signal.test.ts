import { describe, expect, it, vi } from "vitest";
import { viewerSignal } from "./viewer-signal.ts";

const INTERVAL_MS = 60_000;

describe("a connection's viewer signal", () => {
  it("records the first signal at once", () => {
    const record = vi.fn(async () => {});
    const signal = viewerSignal({
      record,
      intervalMs: INTERVAL_MS,
      now: () => 0,
      onError: () => {},
    });

    signal();

    expect(record).toHaveBeenCalledOnce();
  });

  it("records at most once an interval, however fast the frames arrive", () => {
    // The statement throttles across tabs and pods; this stops one client that sends frames in a
    // loop from turning every one of them into a query.
    let clock = 0;
    const record = vi.fn(async () => {});
    const signal = viewerSignal({
      record,
      intervalMs: INTERVAL_MS,
      now: () => clock,
      onError: () => {},
    });

    signal();
    clock = INTERVAL_MS - 1;
    signal();
    signal();
    expect(record).toHaveBeenCalledOnce();

    clock = INTERVAL_MS;
    signal();
    expect(record).toHaveBeenCalledTimes(2);
  });

  it("reports a failed write rather than letting it reject unhandled", async () => {
    // A socket handler that throws takes nothing down, but an unhandled rejection can take the
    // process; and a viewer signal lost costs, at worst, one restore.
    const failure = new Error("database unreachable");
    const onError = vi.fn();
    const signal = viewerSignal({
      record: async () => {
        throw failure;
      },
      intervalMs: INTERVAL_MS,
      now: () => 0,
      onError,
    });

    signal();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledWith(failure));
  });
});
