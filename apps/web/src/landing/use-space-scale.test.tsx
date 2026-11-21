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

/** A space 880 wide, or 400 below a 600px column: one demo's two layouts. */
const design = (width: number) =>
  width < 600 ? { width: 400, layout: "narrow" } : { width: 880, layout: "wide" };

describe("fitting a design space to its column", () => {
  it("writes the ratio of the width it got to the width it was drawn at", () => {
    widthIs(660);
    const view = render(<Space design={design} />);

    expect(scaleOf(view)).toBe("0.75");
  });

  it("follows the column when it changes size", () => {
    widthIs(880);
    const view = render(<Space design={design} />);

    expect(scaleOf(view)).toBe("1");

    widthIs(704);
    observed?.();

    expect(scaleOf(view)).toBe("0.8");
  });

  it("leaves the ratio alone for a box that has not been laid out", () => {
    // A zero width is a print, a hidden ancestor, a test — scaling to zero there would collapse
    // the section outright, where leaving the last known ratio costs nothing.
    widthIs(880);
    const view = render(<Space design={design} />);
    widthIs(0);
    observed?.();

    expect(scaleOf(view)).toBe("1");
    expect(view.getByTestId("space")).toHaveAttribute("data-space", "wide");
  });

  it("names the layout it chose, so the stylesheet can lay the space out for it", () => {
    // A phone gets a space of its own rather than the desktop one shrunk, and the ratio is only
    // right for the layout it was computed for.
    widthIs(500);
    const view = render(<Space design={design} />);
    expect(view.getByTestId("space")).toHaveAttribute("data-space", "narrow");
    expect(scaleOf(view)).toBe("1.25");

    widthIs(800);
    observed?.();
    expect(view.getByTestId("space")).toHaveAttribute("data-space", "wide");
    expect(scaleOf(view)).toBe("0.9090909090909091");
  });

  it("stops measuring when the section goes away", () => {
    widthIs(880);
    const view = render(<Space design={design} />);
    view.unmount();

    expect(disconnected).toBeGreaterThan(0);
  });
});
