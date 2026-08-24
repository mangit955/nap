import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useStickToBottom } from "./use-stick-to-bottom.ts";

/**
 * Following a turn as it is written.
 *
 * jsdom lays nothing out — every element reports a `scrollHeight` and `clientHeight` of zero, and
 * a `scrollTop` that never moves on its own — so the box's metrics are defined on the node
 * directly. That is not a workaround *around* the hook: its whole rule is arithmetic over those
 * three numbers, and defining them is how a test states "the reader is 400px up".
 *
 * Each case drives the real sequence rather than a snapshot of it: mount, then move the reader,
 * then grow the content. The distinction the hook exists to make — was the reader at the bottom
 * *before* this content arrived — is invisible to a test that only sets up an end state.
 */

/** A scroll box whose metrics a test controls, and which records where it was scrolled to. */
function fitOut(node: HTMLElement, scrollHeight: number, clientHeight: number) {
  let top = 0;

  grow(node, scrollHeight);
  Object.defineProperty(node, "clientHeight", { value: clientHeight, configurable: true });
  Object.defineProperty(node, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (next: number) => {
      top = next;
    },
  });
}

function grow(node: HTMLElement, scrollHeight: number) {
  Object.defineProperty(node, "scrollHeight", { value: scrollHeight, configurable: true });
}

function Pane({ count, openAt }: { count: number; openAt?: () => HTMLElement | null }) {
  const ref = useStickToBottom<HTMLDivElement>(count, openAt);

  return (
    <div ref={ref} data-testid="pane">
      {count}
    </div>
  );
}

/** An element inside the box at a known offset, standing in for the transcript's seam marker. */
function marker(offsetTop: number): HTMLElement {
  const node = document.createElement("div");
  Object.defineProperty(node, "offsetTop", { value: offsetTop, configurable: true });
  return node;
}

/** Mounts the pane with a box 400 tall holding 1000 of content, already scrolled to the bottom. */
function mount() {
  const view = render(<div />);
  let pane: HTMLElement | undefined;

  const show = (count: number) => {
    view.rerender(<Pane count={count} />);
    pane ??= view.getByTestId("pane");
    return pane;
  };

  // Laid out before the hook's first effect can read it: the element has to exist, so the pane
  // is rendered once with no metrics, given them, and rendered again.
  view.rerender(<Pane count={0} />);
  fitOut(view.getByTestId("pane"), 1000, 400);
  return { pane: show(1), show };
}

describe("following the transcript", () => {
  it("scrolls to the bottom when the reader is already there", () => {
    // The ordinary case: a turn is running, the reader is watching it, and each event that
    // lands has to be visible without them touching the wheel.
    const { pane, show } = mount();
    expect(pane.scrollTop).toBe(600);

    grow(pane, 1200);
    show(2);

    expect(pane.scrollTop).toBe(800);
  });

  it("leaves the reader alone when they have scrolled up", () => {
    // Somebody reading the diff from four tool calls ago must not be yanked to the bottom
    // because the agent printed another line. This is the case that makes the hook worth a
    // rule rather than a `scrollIntoView` on every render.
    const { pane, show } = mount();

    pane.scrollTop = 120;
    grow(pane, 1200);
    show(2);

    expect(pane.scrollTop).toBe(120);
  });

  it("counts a reader a little way off the bottom as still watching", () => {
    // Exactly pinned is too strict: a trackpad's inertia leaves a box a few pixels short, and a
    // transcript that stopped following after a nudge would look broken.
    const { pane, show } = mount();

    pane.scrollTop = 580;
    grow(pane, 1200);
    show(2);

    expect(pane.scrollTop).toBe(800);
  });

  it("goes to the bottom on the first render, wherever the box starts", () => {
    // Opening a project replays its whole log. The interesting end of a transcript is the
    // newest event, and landing at the top means scrolling past an hour of tool calls to find
    // out what the app currently is.
    const { pane } = mount();

    expect(pane.scrollTop).toBe(600);
  });

  it("stays put when there is nothing to scroll", () => {
    const view = render(<Pane count={1} />);
    const pane = view.getByTestId("pane");
    fitOut(pane, 200, 400);

    view.rerender(<Pane count={2} />);

    // A short transcript would otherwise be given a negative offset, which browsers clamp but
    // jsdom faithfully stores.
    expect(pane.scrollTop).toBe(0);
  });
});

describe("opening at the seam", () => {
  /**
   * The real sequence, which is the whole reason these cases exist: the pane mounts before the
   * log has replayed, so there is no marker to find on the first pass and one appears later.
   */
  function mountWith() {
    let seam: HTMLElement | null = null;
    const openAt = () => seam;

    const view = render(<Pane count={0} openAt={openAt} />);
    const pane = view.getByTestId("pane");
    fitOut(pane, 1000, 400);

    return {
      pane,
      setSeam: (offsetTop: number) => {
        seam = marker(offsetTop);
      },
      show: (count: number) => view.rerender(<Pane count={count} openAt={openAt} />),
    };
  }

  it("opens at the seam rather than at the bottom", () => {
    // Somebody who closed a laptop and came back is returning to work they have not read. The
    // bottom is where the newest event is; the seam is where *their* reading stopped.
    const { pane, setSeam, show } = mountWith();

    setSeam(500);
    show(1);

    expect(pane.scrollTop).toBe(500 - 24);
  });

  it("waits for the seam to exist rather than for the first render", () => {
    // A rule keyed to "the first render" would look while the pane was still empty, find
    // nothing, go to the bottom and never look again — which is every real load of a project.
    const { pane, setSeam, show } = mountWith();

    show(1);
    expect(pane.scrollTop).toBe(600);

    setSeam(500);
    show(2);

    expect(pane.scrollTop).toBe(476);
  });

  it("goes to the seam once, then follows the turn as usual", () => {
    // Scrolling back to the marker every time an event lands would pin the reader to the past
    // while the agent works below them.
    const { pane, setSeam, show } = mountWith();
    setSeam(500);
    show(1);

    pane.scrollTop = 600;
    grow(pane, 1200);
    show(2);

    expect(pane.scrollTop).toBe(800);
  });

  it("never scrolls past what the box can scroll", () => {
    // A marker near the end of a barely-scrollable transcript would otherwise be given an
    // offset the browser clamps and jsdom keeps, leaving the box reporting a position it is
    // not at.
    const { pane, setSeam, show } = mountWith();

    setSeam(5000);
    show(1);

    expect(pane.scrollTop).toBe(600);
  });
});
