import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pageVisibility } from "../testing/page-visibility.ts";
import { startPollLoop } from "./poll-loop.ts";

let page = pageVisibility();
const setVisibility = (state: DocumentVisibilityState) => page.set(state);

beforeEach(() => {
  vi.useFakeTimers();
  page = pageVisibility();
});

afterEach(() => {
  vi.useRealTimers();
  page.restore();
});

/** A read that records each call and answers with whatever delay the test sets. */
function reads(next = 1000) {
  const calls: number[] = [];
  const state = { next };
  const read = async () => {
    calls.push(Date.now());
    return state.next;
  };
  return { read, calls, state };
}

describe("startPollLoop", () => {
  it("waits the first delay, then however long each read asks for", async () => {
    const { read, calls, state } = reads(15_000);
    const loop = startPollLoop({ read, firstDelayMs: 1000 });
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(calls).toHaveLength(1);
    state.next = 1000;
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(3);
    loop.stop();
  });

  it("never starts a read while one is in flight", async () => {
    let release: (delay: number) => void = () => {};
    let started = 0;
    const loop = startPollLoop({
      read: () => {
        started += 1;
        return new Promise<number>((done) => {
          release = done;
        });
      },
      firstDelayMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(started).toBe(1);
    loop.soon(0);
    window.dispatchEvent(new Event("focus"));
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(started).toBe(1);
    release(1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toBe(2);
    loop.stop();
  });

  it("keeps the earliest nudge deadline while a read is in flight, then returns to its cadence", async () => {
    let release: (delay: number) => void = () => {};
    const calls: number[] = [];
    const loop = startPollLoop({
      read: async () => {
        calls.push(Date.now());
        if (calls.length > 1) return 15_000;
        return new Promise<number>((done) => {
          release = done;
        });
      },
      firstDelayMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    loop.soon(1000);
    await vi.advanceTimersByTimeAsync(400);
    loop.soon(1000);
    release(15_000);
    await vi.advanceTimersByTimeAsync(599);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(2);
    expect(calls[1]! - calls[0]!).toBe(1000);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls).toHaveLength(3);
    loop.stop();
  });

  it("does not let an in-flight nudge postpone the read's own shorter cadence", async () => {
    let release: (delay: number) => void = () => {};
    let started = 0;
    const loop = startPollLoop({
      read: () => {
        started += 1;
        return new Promise<number>((done) => {
          release = done;
        });
      },
      firstDelayMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    loop.soon(15_000);
    release(1000);
    await vi.advanceTimersByTimeAsync(999);
    expect(started).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toBe(2);
    loop.stop();
  });

  it("parks an in-flight nudge if the page is hidden before the read settles", async () => {
    let release: (delay: number) => void = () => {};
    let started = 0;
    const loop = startPollLoop({
      read: () => {
        started += 1;
        return new Promise<number>((done) => {
          release = done;
        });
      },
      firstDelayMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    loop.soon(0);
    setVisibility("hidden");
    release(15_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(started).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toBe(2);
    loop.stop();
  });

  it("reads nothing while the page is hidden, and reads once at once when it is shown", async () => {
    const { read, calls } = reads(1000);
    const loop = startPollLoop({ read, firstDelayMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(1);
    setVisibility("hidden");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(calls).toHaveLength(1);
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2);
    // Then back on the read's own cadence, not a second catch-up read.
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(2);
    loop.stop();
  });

  it("starts parked when the page opens hidden", async () => {
    page.restore();
    page = pageVisibility("hidden");
    const { read, calls } = reads(1000);
    const loop = startPollLoop({ read, firstDelayMs: 1000 });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(0);
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(1);
    loop.stop();
  });

  it("reads at once when the window regains focus", async () => {
    const { read, calls } = reads(30_000);
    const loop = startPollLoop({ read, firstDelayMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(1);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls).toHaveLength(2);
    loop.stop();
  });

  it("brings the next read forward with soon, and never pushes it back", async () => {
    const { read, calls } = reads(15_000);
    const loop = startPollLoop({ read, firstDelayMs: 1000 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(1);
    // Due in 15s; asked for within 1s.
    loop.soon(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(calls).toHaveLength(2);
    // Due in 15s again. 14.5s in, a stream of events each asking for "within 1s" must not keep
    // moving it — the read due in half a second still happens then.
    await vi.advanceTimersByTimeAsync(14_500);
    for (let i = 0; i < 5; i++) {
      loop.soon(1000);
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(calls).toHaveLength(3);
    loop.stop();
  });

  it("keeps going after a read throws, at the first delay", async () => {
    let calls = 0;
    const loop = startPollLoop({
      read: async () => {
        calls += 1;
        if (calls === 1) throw new Error("offline");
        return 60_000;
      },
      firstDelayMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toBe(2);
    loop.stop();
  });

  it("leaves no timer and no listener behind once stopped, even with a read in flight", async () => {
    let release: (delay: number) => void = () => {};
    let started = 0;
    const loop = startPollLoop({
      read: () => {
        started += 1;
        return new Promise<number>((done) => {
          release = done;
        });
      },
      firstDelayMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    loop.soon(0);
    loop.stop();
    release(1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    setVisibility("hidden");
    setVisibility("visible");
    window.dispatchEvent(new Event("focus"));
    loop.soon(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(started).toBe(1);
  });
});
