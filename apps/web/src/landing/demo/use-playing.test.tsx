import { act, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePlaying } from "./use-playing.ts";

/**
 * `testing/setup.ts` installs a no-op `IntersectionObserver` only when there is none, so this
 * takes a copy of whatever is there and puts it back — a fake left in place leaks into every file
 * that runs after this one in the same worker.
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

function scroll(into: boolean) {
  const callback = fire;
  if (callback === undefined) throw new Error("nothing ever observed the stage");
  act(() => {
    callback(
      [{ isIntersecting: into } as IntersectionObserverEntry],
      undefined as unknown as IntersectionObserver,
    );
  });
}

function hideTab(hidden: boolean) {
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  act(() => {
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

function Stage() {
  const ref = useRef<HTMLDivElement>(null);
  const playing = usePlaying(ref);
  return <div ref={ref}>{playing ? "playing" : "still"}</div>;
}

const state = () => screen.getByText(/playing|still/).textContent;

beforeEach(() => {
  fire = undefined;
  disconnected = 0;
  original = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = FakeObserver as unknown as typeof IntersectionObserver;
});

afterEach(() => {
  if (original !== undefined) globalThis.IntersectionObserver = original;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
  vi.restoreAllMocks();
});

describe("when the demo may run", () => {
  it("does not start before anything is known about where it is", () => {
    render(<Stage />);

    expect(state()).toBe("still");
  });

  it("runs once it is on screen", () => {
    render(<Stage />);
    scroll(true);

    expect(state()).toBe("playing");
  });

  it("stops when it scrolls away, and starts again when it comes back", () => {
    render(<Stage />);
    scroll(true);
    scroll(false);

    expect(state()).toBe("still");

    scroll(true);

    expect(state()).toBe("playing");
  });

  it("stops when the tab goes away, even though it is still on screen", () => {
    // The observer keeps reporting a visible element in a background tab; without this the loop
    // traces an outline sixty times a second that nobody can see.
    render(<Stage />);
    scroll(true);
    hideTab(true);

    expect(state()).toBe("still");

    hideTab(false);

    expect(state()).toBe("playing");
  });

  it("never runs for a reader who asked for less motion", () => {
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

    render(<Stage />);
    scroll(true);

    expect(state()).toBe("still");
  });

  it("stops watching when it goes away", () => {
    const view = render(<Stage />);
    view.unmount();

    expect(disconnected).toBeGreaterThan(0);
  });
});
