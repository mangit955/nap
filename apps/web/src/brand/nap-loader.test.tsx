import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NapLoader } from "./nap-loader.tsx";
import { REST_MS, TRICKS } from "./nap-tricks.ts";

/**
 * The loader's own job is timing: choose something, hold it for its length, stand still a beat,
 * choose again. What it looks like is CSS and is checked by eye, so what is asserted here is
 * only what a test can actually know — that the attribute the stylesheet selects on changes,
 * that it is always a real trick, and that nothing is left running after the pane goes away.
 */

const NAMES = TRICKS.map((trick) => trick.name);

/** How long the trick now showing lasts — each one sets its own length. */
function lengthOf(name: string | null | undefined): number {
  const trick = TRICKS.find((candidate) => candidate.name === name);
  if (trick === undefined) throw new Error(`not a trick: ${String(name)}`);
  return trick.ms;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the ghost while a project comes up", () => {
  it("stands still for a beat before doing anything", () => {
    // A ghost already mid-hop as the pane appears reads as the page having jumped.
    const { container } = render(<NapLoader />);

    expect(container.querySelector(".nap-loader")?.getAttribute("data-trick")).toBeNull();
  });

  it("performs, then rests, then performs again", () => {
    const { container } = render(<NapLoader />);
    const loader = () => container.querySelector(".nap-loader")?.getAttribute("data-trick");

    act(() => void vi.advanceTimersByTime(REST_MS + 1));
    const first = loader();
    expect(NAMES).toContain(first);

    // Exactly as long as the trick that is showing, since each sets its own length: the
    // attribute then goes away, which is the still beat between two of them.
    act(() => void vi.advanceTimersByTime(lengthOf(first) + 1));
    expect(loader()).toBeNull();

    act(() => void vi.advanceTimersByTime(REST_MS + 1));
    expect(NAMES).toContain(loader());
  });

  it("does something different each time", () => {
    // Otherwise it is a spinner with extra frames: the eye learns one gesture in two cycles.
    const { container } = render(<NapLoader />);
    const seen: (string | null | undefined)[] = [];

    for (let round = 0; round < 6; round += 1) {
      act(() => void vi.advanceTimersByTime(REST_MS + 1));
      const showing = container.querySelector(".nap-loader")?.getAttribute("data-trick");
      seen.push(showing);
      act(() => void vi.advanceTimersByTime(lengthOf(showing) + 1));
    }

    for (const [index, trick] of seen.entries()) {
      if (index > 0) expect(trick).not.toBe(seen[index - 1]);
    }
  });

  it("stops when the pane goes away", () => {
    // A timer that outlives its component sets state on nothing, forever — a leak, and a React
    // warning that turns up in a completely unrelated test.
    const { unmount } = render(<NapLoader />);

    unmount();

    expect(vi.getTimerCount()).toBe(0);
  });

  it("says nothing to a screen reader", () => {
    // The pane's "Starting the dev server…" line is the announcement. A description of a
    // hopping ghost on top of it is noise.
    const { container } = render(<NapLoader />);

    expect(container.querySelector(".nap-loader")).toHaveAttribute("aria-hidden", "true");
  });
});
