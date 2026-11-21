import { render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useSpaceScale } from "./use-space-scale.ts";

/**
 * The ratio this writes is the only thing standing between a fixed design space and a section
 * that renders at 1:1 and hangs off the side of the page — which is exactly what the CSS-only
 * version of this did, silently, for a whole session. So: does it write, does it follow a resize,
 * and does it refuse to write a zero.
 */

let observed: (() => void) | undefined;
let disconnected = 0;
let original: typeof ResizeObserver | undefined;

class FakeResizeObserver {
  constructor(callback: () => void) {
    observed = callback;
  }
  observe() {}
  unobserve() {}
  disconnect() {
    disconnected += 1;
  }
}

/** jsdom lays nothing out, so the width is whatever a test says it is. */
function widthIs(width: number) {
  Element.prototype.getBoundingClientRect = function rect() {
    return { width, height: 0, top: 0, left: 0, right: width, bottom: 0, x: 0, y: 0, toJSON() {} };
  };
}

function Space({ design }: { design: Parameters<typeof useSpaceScale>[1] }) {
  const ref = useRef<HTMLDivElement>(null);
  useSpaceScale(ref, design);
  return <div ref={ref} data-testid="space" />;
}

const scaleOf = (view: { getByTestId: (id: string) => HTMLElement }) =>
  view.getByTestId("space").style.getPropertyValue("--space-k");

const realRect = Element.prototype.getBoundingClientRect;

beforeEach(() => {
  observed = undefined;
  disconnected = 0;
  original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
});

afterEach(() => {
  if (original !== undefined) globalThis.ResizeObserver = original;
  Element.prototype.getBoundingClientRect = realRect;
});

describe("fitting a design space to its column", () => {
  it("writes the ratio of the width it got to the width it was drawn at", () => {
    widthIs(440);
    const view = render(<Space design={880} />);

    expect(scaleOf(view)).toBe("0.5");
  });

  it("follows the column when it changes size", () => {
    widthIs(880);
    const view = render(<Space design={880} />);

    expect(scaleOf(view)).toBe("1");

    widthIs(220);
    observed?.();

    expect(scaleOf(view)).toBe("0.25");
  });

  it("leaves the ratio alone for a box that has not been laid out", () => {
    // A zero width is a print, a hidden ancestor, a test — scaling to zero there would collapse
    // the section outright, where leaving the last known ratio costs nothing.
    widthIs(880);
    const view = render(<Space design={880} />);
    widthIs(0);
    observed?.();

    expect(scaleOf(view)).toBe("1");
  });

  it("draws a narrower space when the column is narrow, if asked to", () => {
    // A phone gets a space of its own, laid out for the width, rather than the desktop one
    // shrunk until its labels are unreadable. The stylesheet switches the layout at the same
    // width, so the ratio has to follow the space the stylesheet chose.
    const design = (width: number) => (width < 600 ? 400 : 1000);
    widthIs(500);
    const view = render(<Space design={design} />);
    expect(scaleOf(view)).toBe("1.25");

    widthIs(800);
    observed?.();
    expect(scaleOf(view)).toBe("0.8");
  });

  it("names the layout it chose, so the stylesheet can follow it", () => {
    // Each demo switches to its narrow space at its own width, which a container query cannot
    // take from the element; the attribute carries the decision the ratio was computed for.
    const design = (width: number) =>
      width < 840
        ? { width: Math.max(420, width), layout: "narrow" }
        : { width: 1280, layout: "wide" };
    widthIs(700);
    const view = render(<Space design={design} />);
    expect(view.getByTestId("space")).toHaveAttribute("data-space", "narrow");
    expect(scaleOf(view)).toBe("1");

    widthIs(1024);
    observed?.();
    expect(view.getByTestId("space")).toHaveAttribute("data-space", "wide");
    expect(scaleOf(view)).toBe("0.8");
  });

  it("stops measuring when the section goes away", () => {
    widthIs(880);
    const view = render(<Space design={880} />);
    view.unmount();

    expect(disconnected).toBeGreaterThan(0);
  });
});
