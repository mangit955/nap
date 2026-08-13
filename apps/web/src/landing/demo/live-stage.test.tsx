import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveStage } from "./live-stage.tsx";
import { SPACE, STEPS } from "./script.ts";

/**
 * What is worth asserting about a component whose whole job is to move: that it is invisible to
 * anything that cannot see it, that it draws something before the first frame, and that it stops.
 * Nothing here asserts on positions — that is `script.test.ts`'s job, where the answers are
 * numbers rather than pixels.
 */

type Callback = ConstructorParameters<typeof IntersectionObserver>[0];

let fire: Callback | undefined;
let original: typeof IntersectionObserver | undefined;

class FakeObserver {
  constructor(callback: Callback) {
    fire = callback;
  }
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

function scrollIntoView() {
  const callback = fire;
  if (callback === undefined) throw new Error("nothing ever observed the stage");
  act(() => {
    callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      undefined as unknown as IntersectionObserver,
    );
  });
}

function reduceMotion() {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: true,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      }) as MediaQueryList,
  );
}

beforeEach(() => {
  fire = undefined;
  original = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = FakeObserver as unknown as typeof IntersectionObserver;
});

afterEach(() => {
  if (original !== undefined) globalThis.IntersectionObserver = original;
  vi.restoreAllMocks();
});

describe("the stage", () => {
  it("is hidden from anything reading the page rather than looking at it", () => {
    // It illustrates the copy beside it. Announced, a reader would get a tool call every second
    // and no sense at all of what the section says.
    const { container } = render(<LiveStage />);

    expect(container.firstElementChild).toHaveAttribute("aria-hidden", "true");
    // Through `closest`, not a text query: testing-library's text queries walk the DOM rather
    // than the accessibility tree, and happily find content inside an `aria-hidden` subtree.
    expect(screen.getByText(STEPS[0].target).closest("[aria-hidden='true']")).not.toBeNull();
  });

  it("draws a turn in progress before a single frame has run", () => {
    // Server-rendered, and what a visitor with no JavaScript is left with. An empty bar here
    // would say the product does nothing.
    const { container } = render(<LiveStage />);
    const outline = container.querySelector("path")?.getAttribute("d") ?? "";

    expect(outline.startsWith("M ")).toBe(true);
    expect(container.querySelectorAll("[data-state]")).toHaveLength(STEPS.length);
    expect(container.querySelector('[data-state="running"]')).not.toBeNull();
  });

  it("traces exactly one shape, however many boxes it was built from", () => {
    // The tab is fused to the body, not stacked on it. Two subpaths here is the blend failing.
    const { container } = render(<LiveStage />);
    const outline = container.querySelector("path")?.getAttribute("d") ?? "";

    expect(outline.split("Z").filter((part) => part.trim() !== "")).toHaveLength(1);
  });

  it("hands the stylesheet the space the script places its boxes in", () => {
    // Every coordinate in the script is a plain pixel in this space, so the box that scales it has
    // to be these exact numbers. They go across as a custom property rather than a Tailwind
    // arbitrary property, because that syntax compiles to nothing and fails by rendering the stage
    // at 1:1 — visible only as an overflow on a narrow screen.
    const { container } = render(<LiveStage />);

    expect(container.firstElementChild).toHaveStyle({ "--space-w": `${SPACE.w}` });
  });

  it("runs nothing at all until it is on screen", () => {
    const raf = vi.spyOn(window, "requestAnimationFrame");

    render(<LiveStage />);

    expect(raf).not.toHaveBeenCalled();

    scrollIntoView();

    expect(raf).toHaveBeenCalled();
  });

  it("runs nothing at all for a reader who asked for less motion", () => {
    // Not "runs slower" and not "runs and is ignored": no frame is ever scheduled.
    reduceMotion();
    const raf = vi.spyOn(window, "requestAnimationFrame");

    render(<LiveStage />);
    scrollIntoView();

    expect(raf).not.toHaveBeenCalled();
  });

  it("stops when it goes away", () => {
    // A loop outliving its component keeps writing to detached nodes for as long as the tab is
    // open, and nothing on screen ever shows it.
    const cancel = vi.spyOn(window, "cancelAnimationFrame");
    const view = render(<LiveStage />);
    scrollIntoView();

    view.unmount();

    expect(cancel).toHaveBeenCalled();
  });
});
