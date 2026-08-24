import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSeen } from "./unseen.ts";
import { useSeenCursor } from "./use-seen-cursor.ts";

const SESSION = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";
const OTHER = "1c8f9f2e-4d3b-4e6c-8f7a-2b3c4d5e6f70";

/**
 * The cursor is durable, so every case here is about what survives a mount — and the only way to
 * state that is to unmount and mount again. `localStorage` is jsdom's real one, cleared between
 * tests, because the thing under test is precisely that it is written to.
 */
beforeEach(() => {
  localStorage.clear();
  hide(false);
});

afterEach(() => {
  hide(false);
});

/** jsdom reports a document that is always visible; the tests need to say otherwise. */
function hide(hidden: boolean) {
  Object.defineProperty(document, "visibilityState", {
    value: hidden ? "hidden" : "visible",
    configurable: true,
  });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

/** One page load: mount, receive events up to `lastSeq`, and go away again. */
function visit(lastSeq: number, sessionId: string = SESSION) {
  const view = renderHook(({ seq }) => useSeenCursor(sessionId, seq), {
    initialProps: { seq: 0 },
  });
  view.rerender({ seq: lastSeq });
  return view;
}

describe("the seen cursor", () => {
  it("marks nothing on a session this browser has never opened", () => {
    // A first visit replays the whole log. All of it is new and none of it is *missed*, and a
    // seam above the first thing the user ever said would say otherwise.
    const { result } = visit(12);

    expect(result.current).toBeUndefined();
  });

  it("does not count an empty visit as having seen nothing", () => {
    // Opening a project and closing it before a single event arrives. A cursor of zero would be
    // written down and read back as a real place, putting the seam above the first thing
    // anybody ever said — the one wrong answer that looks exactly like a right one.
    visit(0).unmount();

    const { result } = visit(30);

    expect(result.current).toBeUndefined();
  });

  it("records what it displayed, so the next visit knows where reading stopped", () => {
    const first = visit(12);
    first.unmount();

    const { result } = visit(30);

    expect(result.current).toBe(12);
  });

  it("does not move the seam while the reader watches the log grow", () => {
    visit(12).unmount();

    const view = renderHook(({ seq }) => useSeenCursor(SESSION, seq), {
      initialProps: { seq: 12 },
    });
    view.rerender({ seq: 40 });

    // The line stays where their reading stopped. A marker that slid down to the newest event
    // as the turn ran would be a marker that never marks anything.
    expect(view.result.current).toBe(12);
    // …and the cursor follows along underneath it, so closing the tab now is recorded.
    expect(readSeen(localStorage, SESSION)).toBe(40);
  });

  it("keeps one session's cursor out of another's", () => {
    visit(12).unmount();

    const { result } = visit(30, OTHER);

    expect(result.current).toBeUndefined();
    expect(readSeen(localStorage, SESSION)).toBe(12);
  });

  it("stops counting events as displayed while the tab is hidden", () => {
    const view = renderHook(({ seq }) => useSeenCursor(SESSION, seq), {
      initialProps: { seq: 0 },
    });
    view.rerender({ seq: 12 });

    hide(true);
    // The socket stays open in a background tab and the worker keeps going, so events arrive at
    // a page nobody is looking at. Counting them as displayed is how "while you were away"
    // becomes a feature that never fires.
    view.rerender({ seq: 40 });

    expect(readSeen(localStorage, SESSION)).toBe(12);
  });

  it("marks the seam on coming back to a tab that was left open", () => {
    const view = renderHook(({ seq }) => useSeenCursor(SESSION, seq), {
      initialProps: { seq: 0 },
    });
    view.rerender({ seq: 12 });

    hide(true);
    view.rerender({ seq: 40 });
    hide(false);

    expect(view.result.current).toBe(12);
  });

  it("has no cursor at all without a session", () => {
    // What the workspace renders before the project record has arrived: there is no log yet, so
    // there is nothing to have seen.
    const { result } = renderHook(() => useSeenCursor(undefined, 0));

    expect(result.current).toBeUndefined();
  });
});
