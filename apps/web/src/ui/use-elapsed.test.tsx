import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useElapsed } from "./use-elapsed.ts";

/**
 * The one hard fact on a loading screen: how long this has been going on. It is what tells slow
 * apart from stuck, so it has to keep counting when nothing else is happening.
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("elapsed time", () => {
  it("counts whole seconds when asked for them", () => {
    const { result } = renderHook(() => useElapsed({ precision: 0 }));

    act(() => void vi.advanceTimersByTime(3_000));

    expect(result.current).toBe("3s");
  });

  it("reads the clock rather than counting ticks", () => {
    // A throttled background tab fires intervals late and rarely. A counter that added a fixed
    // step per fire would drift further behind the longer nobody was looking — and this number
    // exists precisely to be trusted during a long wait.
    const { result } = renderHook(() => useElapsed({ precision: 0, tickMs: 500 }));

    // One tick fires, but ten seconds of wall clock have passed: the jump, plus the half second
    // the tick itself moves the clock on by.
    act(() => {
      vi.setSystemTime(Date.now() + 9_500);
      vi.advanceTimersByTime(500);
    });

    expect(result.current).toBe("10s");
  });

  it("counts from when the server says it began", () => {
    const startedAt = new Date(Date.now() - 8_000).toISOString();

    const { result } = renderHook(() => useElapsed({ startedAt, precision: 0 }));

    expect(result.current).toBe("8s");
  });

  it("never reports a wait that has not started", () => {
    // The anchor comes from the server and the subtraction from the browser; a clock a few
    // seconds ahead would otherwise render a negative count.
    const startedAt = new Date(Date.now() + 5_000).toISOString();

    const { result } = renderHook(() => useElapsed({ startedAt, precision: 0 }));

    expect(result.current).toBe("0s");
  });

  it("switches to minutes once there are some", () => {
    const { result } = renderHook(() => useElapsed({ precision: 0 }));

    act(() => void vi.advanceTimersByTime(95_000));

    expect(result.current).toBe("1m 35s");
  });
});
