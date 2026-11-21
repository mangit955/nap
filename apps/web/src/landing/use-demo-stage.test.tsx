import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUILDING_AFTER_MS, READY_AFTER_MS, useDemoStage } from "./use-demo-stage.ts";

/**
 * The hero's session plays its build once, when somebody can see it. Every test is one of the
 * ways that could go wrong: playing to nobody, never finishing, or animating for a visitor who
 * asked for no motion.
 *
 * `testing/setup.ts` installs a no-op `IntersectionObserver` only when there is none, so this
 * puts back whatever was there, as `use-reveal.test.tsx` does.
 */

type Callback = ConstructorParameters<typeof IntersectionObserver>[0];

let fire: Callback | undefined;
let observers = 0;
// A disconnected observer delivers nothing more, as a real one does.
let connected = false;
let original: typeof IntersectionObserver | undefined;
let reduce = false;
let motionChanged: ((event: { matches: boolean }) => void) | undefined;

class FakeObserver {
  constructor(callback: Callback) {
    fire = callback;
    observers += 1;
    connected = true;
  }
  observe() {}
  unobserve() {}
  disconnect() {
    connected = false;
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}

/** `queued` delivers an entry the observer had queued before it was disconnected, which a real
 *  observer may still hand over. */
function intersect(isIntersecting = true, { queued = false } = {}) {
  const callback = fire;
  if (callback === undefined) throw new Error("nothing ever observed the element");
  if (!connected && !queued) return;
  act(() => {
    callback(
      [{ isIntersecting } as IntersectionObserverEntry],
      undefined as unknown as IntersectionObserver,
    );
  });
}

function Stage() {
  const { ref, stage } = useDemoStage<HTMLDivElement>();
  return <div ref={ref}>{stage}</div>;
}

const advance = (ms: number) =>
  act(() => {
    vi.advanceTimersByTime(ms);
  });

beforeEach(() => {
  vi.useFakeTimers();
  fire = undefined;
  observers = 0;
  connected = false;
  reduce = false;
  motionChanged = undefined;
  original = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = FakeObserver as unknown as typeof IntersectionObserver;
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query) =>
      ({
        matches: reduce && query.includes("reduce"),
        media: query,
        addEventListener: (_: string, listener: (event: { matches: boolean }) => void) => {
          motionChanged = listener;
        },
        removeEventListener: () => {},
      }) as unknown as MediaQueryList,
  );
});

afterEach(() => {
  vi.useRealTimers();
  if (original !== undefined) globalThis.IntersectionObserver = original;
  vi.restoreAllMocks();
});

describe("the hero session's build", () => {
  it("waits at the prompt until it is on screen", () => {
    render(<Stage />);
    advance(READY_AFTER_MS * 2);
    expect(screen.getByText("prompt")).toBeInTheDocument();
  });

  it("does not start for an entry that is not intersecting", () => {
    render(<Stage />);
    intersect(false);
    advance(READY_AFTER_MS * 2);
    expect(screen.getByText("prompt")).toBeInTheDocument();
  });

  it("plays through building to the finished app once it is seen", () => {
    render(<Stage />);
    intersect();
    advance(BUILDING_AFTER_MS - 1);
    expect(screen.getByText("prompt")).toBeInTheDocument();
    advance(1);
    expect(screen.getByText("building")).toBeInTheDocument();
    advance(READY_AFTER_MS - BUILDING_AFTER_MS);
    expect(screen.getByText("ready")).toBeInTheDocument();
  });

  it("plays only once, however often it scrolls back into view", () => {
    render(<Stage />);
    intersect();
    advance(READY_AFTER_MS);
    intersect(false);
    intersect();
    advance(BUILDING_AFTER_MS);
    expect(screen.getByText("ready")).toBeInTheDocument();
  });

  it("shows the finished app at once when motion is reduced", () => {
    reduce = true;
    render(<Stage />);
    expect(screen.getByText("ready")).toBeInTheDocument();
    expect(observers).toBe(0);
  });

  it("finishes at once when reduced motion is turned on mid-build", () => {
    render(<Stage />);
    intersect();
    advance(BUILDING_AFTER_MS);
    expect(screen.getByText("building")).toBeInTheDocument();
    act(() => motionChanged?.({ matches: true }));
    expect(screen.getByText("ready")).toBeInTheDocument();
  });

  it("stays finished when an entry queued before reduced motion arrives after it", () => {
    render(<Stage />);
    act(() => motionChanged?.({ matches: true }));
    intersect(true, { queued: true });
    advance(BUILDING_AFTER_MS);
    expect(screen.getByText("ready")).toBeInTheDocument();
  });

  it("shows the finished app when nothing could ever report it on screen", () => {
    // @ts-expect-error -- a browser without the API
    globalThis.IntersectionObserver = undefined;
    render(<Stage />);
    expect(screen.getByText("ready")).toBeInTheDocument();
  });
});
