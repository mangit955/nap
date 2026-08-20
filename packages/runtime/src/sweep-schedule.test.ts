import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startSweeping } from "./sweep-schedule.ts";

/**
 * The timer both sweeps run on, on its own because neither of them owns it.
 *
 * It takes the sweep as a dependency rather than building one, so these are about ticking and
 * nothing else — no sandbox, no store, and no back door into either caller that production does
 * not use.
 */

describe("a sweep on a timer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function counting(): { sweep: () => Promise<void>; calls: () => number } {
    let calls = 0;
    return {
      calls: () => calls,
      sweep: async () => {
        calls += 1;
      },
    };
  }

  it("does not sweep the moment it starts", () => {
    const { sweep, calls } = counting();

    const schedule = startSweeping({ intervalMs: 60_000, sweep });

    expect(calls()).toBe(0);
    schedule.stop();
  });

  it("sweeps on every tick", async () => {
    const { sweep, calls } = counting();
    const schedule = startSweeping({ intervalMs: 60_000, sweep });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls()).toBe(2);

    schedule.stop();
  });

  it("leaves no timer behind when stopped", () => {
    // Asserted on the resource rather than on a flag: a `stopped` boolean that suppresses the
    // work still leaks the interval, and the process never exits.
    const schedule = startSweeping({ intervalMs: 60_000, sweep: counting().sweep });

    schedule.stop();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("skips a tick that lands while the previous sweep is still running", async () => {
    // A sweep talks to sandboxes and an object store over the network; two overlapping would
    // try to tear the same project down twice.
    let release = () => {};
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const schedule = startSweeping({
      intervalMs: 60_000,
      sweep: () => {
        calls += 1;
        return blocked;
      },
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(1);

    release();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toBe(2);

    schedule.stop();
  });

  it("keeps sweeping after one fails, and reports it", async () => {
    // An unhandled rejection ends the Bun process, which would turn one bad sweep into an
    // outage for every open tab.
    const failures: unknown[] = [];
    let calls = 0;
    const schedule = startSweeping({
      intervalMs: 60_000,
      sweep: () => {
        calls += 1;
        return Promise.reject(new Error("the database went away"));
      },
      onError: (error) => failures.push(error),
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(calls).toBe(2);
    expect(failures).toHaveLength(2);
    schedule.stop();
  });
});
