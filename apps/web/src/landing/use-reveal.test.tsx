import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { revealProps, useReveal } from "./use-reveal.ts";

/**
 * The hook is a promise that content will be shown again, so every test here is really the same
 * question asked from a different angle: can anything leave a section hidden for good?
 *
 * `testing/setup.ts` installs a no-op `IntersectionObserver` only when there is none, so this
 * takes a copy of whatever is there and puts it back afterwards — otherwise the fake leaks into
 * every test file that runs after this one in the same worker.
 */

type Callback = ConstructorParameters<typeof IntersectionObserver>[0];

let fire: Callback | undefined;
let disconnected = 0;
let original: typeof IntersectionObserver | undefined;

class FakeObserver {
  constructor(callback: Callback) {
    fire = callback;
  }
  observe() {}
  unobserve() {}
  disconnect() {
    disconnected += 1;
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

function intersect() {
  const callback = fire;
  if (callback === undefined) throw new Error("nothing ever observed the element");
  act(() => {
    callback(
      [{ isIntersecting: true } as IntersectionObserverEntry],
      undefined as unknown as IntersectionObserver,
    );
  });
}

function Section() {
  const { ref, state } = useReveal<HTMLDivElement>();
  return (
    <div ref={ref} {...revealProps(state)}>
      <p>a capability</p>
    </div>
  );
}

const shown = () => screen.getByText("a capability").parentElement;

beforeEach(() => {
  fire = undefined;
  disconnected = 0;
  original = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = FakeObserver as unknown as typeof IntersectionObserver;
});

afterEach(() => {
  if (original !== undefined) globalThis.IntersectionObserver = original;
  vi.restoreAllMocks();
});

describe("revealing a section", () => {
  it("arms itself only after mounting, so the markup it renders is never hidden", () => {
    // The server sends this HTML. If it carried the hiding attribute, a visitor with no
    // JavaScript would get a page of blank sections.
    expect(revealProps("idle")["data-reveal"]).toBeUndefined();
  });

  it("hides the section once it has an observer to bring it back", () => {
    render(<Section />);

    expect(shown()).toHaveAttribute("data-reveal", "pending");
  });

  it("shows it when it comes into view, and stops watching", () => {
    render(<Section />);
    intersect();

    expect(shown()).toHaveAttribute("data-reveal", "in");
    expect(disconnected).toBeGreaterThan(0);
  });

  it("does not hide it again when it leaves view", () => {
    // Content that re-hides on scroll-up punishes the person who scrolled back to reread it.
    render(<Section />);
    intersect();
    act(() => {
      fire?.(
        [{ isIntersecting: false } as IntersectionObserverEntry],
        undefined as unknown as IntersectionObserver,
      );
    });

    expect(shown()).toHaveAttribute("data-reveal", "in");
  });

  it("never hides anything when the reader asked for less motion", () => {
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

    render(<Section />);

    expect(shown()).not.toHaveAttribute("data-reveal");
  });

  it("leaves the section alone when the browser has no observer at all", () => {
    // Hiding here would be permanent: there would be nothing left to fire.
    globalThis.IntersectionObserver = undefined as unknown as typeof IntersectionObserver;

    render(<Section />);

    expect(shown()).not.toHaveAttribute("data-reveal");
  });
});

describe("the delay", () => {
  it("is written as a custom property, so one rule staggers a whole row", () => {
    expect(revealProps("pending", 120).style).toEqual({ "--nap-reveal-delay": "120ms" });
  });

  it("is left off entirely when there is none", () => {
    expect(revealProps("pending").style).toBeUndefined();
  });
});
