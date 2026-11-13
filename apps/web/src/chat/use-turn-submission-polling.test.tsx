import type { NapEvent, NapEventType } from "@nap/shared/events";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pageVisibility } from "../testing/page-visibility.ts";
import { ACTIVITY_BUSY_MS, ACTIVITY_IDLE_MS, useTurnSubmission } from "./use-turn-submission.ts";

/**
 * How often the workspace asks the server whether its session is busy, and when it does not ask.
 *
 * The answer drives Stop, Cancel and the retirement of idle history (see the hook), so the rules
 * here are about *when* it is asked: often while anything runs, rarely while nothing does, never
 * from a hidden tab — and that an answer identical to the last one changes nothing on screen.
 * What the answer *means* is `use-session-activity.test.tsx`'s, against the real routes.
 */

const SESSION = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";
const OTHER = "1c8f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";
const TURN = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
const NEXT_TURN = "8d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a";

function ev<T extends NapEventType>(
  type: T,
  payload: Extract<NapEvent, { type: T }>["payload"],
  seq: number,
  turnId = TURN,
): StoredEvent {
  return {
    type,
    sessionId: SESSION,
    turnId,
    seq,
    createdAt: "2026-11-13T12:00:00.000Z",
    payload,
  } as StoredEvent;
}

const started = (seq: number, turnId = TURN) => ev("turn.started", { source: "user" }, seq, turnId);
const said = (seq: number, turnId = TURN) => ev("user.message", { text: "Build it" }, seq, turnId);
const stopped = (seq: number) =>
  ev("turn.failed", { reason: "cancelled", message: "Stopped" }, seq);

/**
 * The activity route, as a switch the test flips. It answers the cursor it was asked about, which
 * is what the real one does for a cursor it holds history for.
 */
function server(options: { active?: boolean; hold?: boolean } = {}) {
  const state = { active: options.active ?? false, down: false };
  const reads: { cursor: number; signal: AbortSignal | null | undefined }[] = [];
  let release: () => void = () => {};
  let hold = options.hold ?? false;
  const fetchJson = async (url: string, init?: RequestInit): Promise<Response> => {
    const parsed = new URL(url);
    if (!parsed.pathname.endsWith("/activity")) throw new Error(`unexpected ${parsed.pathname}`);
    const cursor = Number(parsed.searchParams.get("cursor"));
    reads.push({ cursor, signal: init?.signal });
    if (state.down) return Response.json({ error: "unavailable" }, { status: 503 });
    const sessionId = parsed.pathname.split("/")[2];
    const answer = { sessionId, throughSeq: cursor, active: state.active };
    if (hold) {
      hold = false;
      await new Promise<void>((done) => {
        release = done;
      });
    }
    return Response.json(answer);
  };
  return { fetchJson, reads, state, release: () => release() };
}

/** The hook over a log the test hands it, counting how many times it rendered. */
function mount(api: ReturnType<typeof server>, events: StoredEvent[] = []) {
  const renders = { count: 0 };
  const hook = renderHook(
    ({ log, sessionId }: { log: StoredEvent[]; sessionId: string }) => {
      renders.count += 1;
      return useTurnSubmission({ sessionId, events: log, fetchJson: api.fetchJson });
    },
    { initialProps: { log: events, sessionId: SESSION } },
  );
  return { hook, renders };
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

let page = pageVisibility();

beforeEach(() => {
  vi.useFakeTimers();
  page = pageVisibility();
});

afterEach(() => {
  vi.useRealTimers();
  page.restore();
});

describe("how often the session's activity is read", () => {
  it("backs off strongly while the session is idle and visible", async () => {
    expect(ACTIVITY_IDLE_MS).toBeGreaterThanOrEqual(10 * ACTIVITY_BUSY_MS);
    const api = server();
    const { hook } = mount(api);
    await advance(ACTIVITY_BUSY_MS);
    expect(api.reads).toHaveLength(1);
    expect(hook.result.current.running).toBe(false);
    await advance(ACTIVITY_IDLE_MS - 1);
    expect(api.reads).toHaveLength(1);
    await advance(1);
    expect(api.reads).toHaveLength(2);
    hook.unmount();
  });

  it("keeps the fast cadence while the server says work is queued or running", async () => {
    const api = server({ active: true });
    const { hook } = mount(api);
    await advance(ACTIVITY_BUSY_MS);
    expect(hook.result.current.running).toBe(true);
    await advance(5 * ACTIVITY_BUSY_MS);
    expect(api.reads).toHaveLength(6);
    hook.unmount();
  });

  it("keeps the fast cadence while the log shows a turn in flight and the server cannot answer", async () => {
    // A failed read proves nothing idle, so the turn the log shows is still the truth on screen —
    // and the one answer that could end it should be asked for quickly, not after the back-off.
    const api = server();
    api.state.down = true;
    const { hook } = mount(api, [said(1), started(2)]);
    await advance(ACTIVITY_BUSY_MS);
    expect(hook.result.current.running).toBe(true);
    await advance(3 * ACTIVITY_BUSY_MS);
    expect(api.reads).toHaveLength(4);
    hook.unmount();
  });

  it("reads nothing from a hidden tab, and reads once, at once, when it is shown again", async () => {
    const api = server({ active: true });
    const { hook } = mount(api);
    await advance(ACTIVITY_BUSY_MS);
    expect(api.reads).toHaveLength(1);
    act(() => page.set("hidden"));
    await advance(10 * ACTIVITY_IDLE_MS);
    expect(api.reads).toHaveLength(1);
    act(() => page.set("visible"));
    await advance(0);
    expect(api.reads).toHaveLength(2);
    hook.unmount();
  });

  it("brings an idle read forward when the log moves, without waiting out the back-off", async () => {
    const api = server();
    const { hook } = mount(api);
    await advance(ACTIVITY_BUSY_MS);
    await advance(2000);
    expect(api.reads).toHaveLength(1);
    hook.rerender({ log: [said(1)], sessionId: SESSION });
    await advance(ACTIVITY_BUSY_MS);
    expect(api.reads).toHaveLength(2);
    expect(api.reads[1]?.cursor).toBe(1);
    hook.unmount();
  });

  it("finds another client's eventless queued work on the idle cadence, or at once on focus", async () => {
    const api = server();
    const { hook } = mount(api);
    await advance(ACTIVITY_BUSY_MS);
    api.state.active = true;
    await advance(ACTIVITY_BUSY_MS);
    expect(hook.result.current.running).toBe(false);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    await advance(0);
    expect(hook.result.current.running).toBe(true);
    hook.unmount();
  });
});

describe("what an answer changes", () => {
  it("renders nothing for an answer identical to the last", async () => {
    const api = server({ active: true });
    const { hook, renders } = mount(api);
    await advance(ACTIVITY_BUSY_MS);
    expect(hook.result.current.running).toBe(true);
    const settled = renders.count;
    const result = hook.result.current;
    // One read per `act`, as a browser delivers each response in a task of its own: React batches
    // everything inside one `act`, so ten updates there would render once and prove nothing.
    for (let read = 0; read < 10; read++) await advance(ACTIVITY_BUSY_MS);
    expect(api.reads).toHaveLength(11);
    expect(renders.count).toBe(settled);
    expect(hook.result.current).toBe(result);
    hook.unmount();
  });

  it("still renders an answer that differs", async () => {
    const api = server({ active: true });
    const { hook, renders } = mount(api);
    await advance(ACTIVITY_BUSY_MS);
    const settled = renders.count;
    api.state.active = false;
    await advance(ACTIVITY_BUSY_MS);
    expect(renders.count).toBeGreaterThan(settled);
    expect(hook.result.current.running).toBe(false);
    hook.unmount();
  });

  it("drops Stop within the fast cadence when a queued turn is cancelled before it runs", async () => {
    const api = server({ active: true });
    const { hook } = mount(api);
    await advance(ACTIVITY_BUSY_MS);
    expect(hook.result.current.running).toBe(true);
    // Cancelled while still queued: no event will ever say so, only the queue.
    api.state.active = false;
    await advance(ACTIVITY_BUSY_MS);
    expect(hook.result.current.running).toBe(false);
    hook.unmount();
  });

  it("follows a running turn's start and stop from the log without waiting on a read", async () => {
    const api = server();
    const { hook } = mount(api);
    await advance(ACTIVITY_BUSY_MS);
    hook.rerender({ log: [said(1), started(2)], sessionId: SESSION });
    expect(hook.result.current.running).toBe(true);
    expect(hook.result.current.startedAt).toBe("2026-11-13T12:00:00.000Z");
    hook.rerender({ log: [said(1), started(2), stopped(3)], sessionId: SESSION });
    expect(hook.result.current.running).toBe(false);
    hook.unmount();
  });

  it("discards an idle answer the log overtook, keeping the newer turn on screen and asked about quickly", async () => {
    const api = server({ hold: true });
    const { hook } = mount(api, [said(1), started(2), stopped(3)]);
    await advance(ACTIVITY_BUSY_MS);
    expect(api.reads).toHaveLength(1);
    // A new turn arrives while the idle answer for cursor 3 is still on its way.
    hook.rerender({
      log: [said(1), started(2), stopped(3), said(4, NEXT_TURN), started(5, NEXT_TURN)],
      sessionId: SESSION,
    });
    await act(async () => api.release());
    expect(hook.result.current.running).toBe(true);
    expect(hook.result.current.idleThroughSeq).toBe(0);
    await advance(ACTIVITY_BUSY_MS);
    expect(api.reads).toHaveLength(2);
    expect(api.reads[1]?.cursor).toBe(5);
    hook.unmount();
  });

  it("ignores an answer that arrives after the workspace moved to another session", async () => {
    const api = server({ active: true, hold: true });
    const { hook } = mount(api);
    await advance(ACTIVITY_BUSY_MS);
    hook.rerender({ log: [], sessionId: OTHER });
    expect(api.reads[0]?.signal?.aborted).toBe(true);
    await act(async () => api.release());
    expect(hook.result.current.running).toBe(false);
    hook.unmount();
  });
});

describe("cleaning up", () => {
  it("leaves no timer behind on unmount, with a read in flight", async () => {
    const api = server({ hold: true });
    const { hook } = mount(api);
    await advance(ACTIVITY_BUSY_MS);
    expect(api.reads).toHaveLength(1);
    hook.unmount();
    expect(api.reads[0]?.signal?.aborted).toBe(true);
    api.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    window.dispatchEvent(new Event("focus"));
    page.set("visible");
    await vi.advanceTimersByTimeAsync(10 * ACTIVITY_IDLE_MS);
    expect(api.reads).toHaveLength(1);
  });

  it("leaves no timer behind on unmount from a hidden tab", async () => {
    const api = server();
    const { hook } = mount(api);
    await advance(ACTIVITY_BUSY_MS);
    act(() => page.set("hidden"));
    hook.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
