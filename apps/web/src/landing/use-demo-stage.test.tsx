import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  READY_WAIT_MS,
  useDemoStage,
  VERIFIED_AFTER_MS,
  VERIFYING_AFTER_MS,
} from "./use-demo-stage.ts";

/**
 * The hero's session plays its run once, when somebody can see it. Every test is one of the
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
function intersect(
  isIntersecting = true,
  { queued = false, ratio = isIntersecting ? 1 : 0, shown = 0, viewport = 900 } = {},
) {
  const callback = fire;
  if (callback === undefined) throw new Error("nothing ever observed the element");
  if (!connected && !queued) return;
  act(() => {
    callback(
      [
        {
          isIntersecting,
          intersectionRatio: ratio,
          intersectionRect: { height: shown },
          rootBounds: { height: viewport },
        } as IntersectionObserverEntry,
      ],
      undefined as unknown as IntersectionObserver,
    );
  });
}

function Stage({ ready }: { ready?: boolean }) {
  const { ref, stage } = useDemoStage<HTMLDivElement>(ready);
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

describe("the hero session's run", () => {
  it("waits at the first beat until it is on screen", () => {
    render(<Stage />);
    advance(VERIFIED_AFTER_MS * 2);
    expect(screen.getByText("working")).toBeInTheDocument();
  });

  it("does not start for an entry that is not intersecting", () => {
    render(<Stage />);
    intersect(false);
    advance(VERIFIED_AFTER_MS * 2);
    expect(screen.getByText("working")).toBeInTheDocument();
  });

  it("does not spend its one play on a sliver at the edge of the screen", () => {
    // An observer reports a first entry whatever its thresholds, and `isIntersecting` is true for
    // a single row of pixels. Starting there plays the run to somebody who cannot see it.
    render(<Stage />);
    intersect(true, { ratio: 0.05 });
    advance(VERIFIED_AFTER_MS * 2);
    expect(screen.getByText("working")).toBeInTheDocument();
    intersect(true, { ratio: 0.5 });
    advance(VERIFYING_AFTER_MS);
    expect(screen.getByText("verifying")).toBeInTheDocument();
  });

  it("waits for its first frame to be drawn before it starts the clock", () => {
    // The first beat's diff draws a moment after the page does. Starting before it would spend
    // the beat on "Loading diff…".
    const view = render(<Stage ready={false} />);
    intersect();
    advance(VERIFYING_AFTER_MS);
    expect(screen.getByText("working")).toBeInTheDocument();
    view.rerender(<Stage ready />);
    advance(VERIFYING_AFTER_MS - 1);
    expect(screen.getByText("working")).toBeInTheDocument();
    advance(1);
    expect(screen.getByText("verifying")).toBeInTheDocument();
  });

  it("does not spend its play offscreen when the frame draws after the reader scrolled on", () => {
    const view = render(<Stage ready={false} />);
    intersect(true, { ratio: 0.5 });
    intersect(false);
    view.rerender(<Stage ready />);
    advance(VERIFIED_AFTER_MS * 2);
    expect(screen.getByText("working")).toBeInTheDocument();
    intersect(true, { ratio: 0.5 });
    advance(VERIFYING_AFTER_MS);
    expect(screen.getByText("verifying")).toBeInTheDocument();
  });

  it("plays in a window too short to show a third of it, once it fills most of the window", () => {
    // A 210px-tall window can show at most 31% of a 680px hero.
    render(<Stage />);
    intersect(true, { ratio: 0.31, shown: 210, viewport: 210 });
    advance(VERIFYING_AFTER_MS);
    expect(screen.getByText("verifying")).toBeInTheDocument();
  });

  it("starts anyway when the first frame never draws", () => {
    render(<Stage ready={false} />);
    intersect();
    advance(READY_WAIT_MS + VERIFYING_AFTER_MS);
    expect(screen.getByText("verifying")).toBeInTheDocument();
  });

  it("plays through verifying to verified once it is seen", () => {
    render(<Stage />);
    intersect();
    advance(VERIFYING_AFTER_MS - 1);
    expect(screen.getByText("working")).toBeInTheDocument();
    advance(1);
    expect(screen.getByText("verifying")).toBeInTheDocument();
    advance(VERIFIED_AFTER_MS - VERIFYING_AFTER_MS);
    expect(screen.getByText("verified")).toBeInTheDocument();
  });

  it("plays only once, however often it scrolls back into view", () => {
    render(<Stage />);
    intersect();
    advance(VERIFIED_AFTER_MS);
    intersect(false);
    intersect();
    advance(VERIFYING_AFTER_MS);
    expect(screen.getByText("verified")).toBeInTheDocument();
  });

  it("shows the verified result at once when motion is reduced", () => {
    reduce = true;
    render(<Stage />);
    expect(screen.getByText("verified")).toBeInTheDocument();
    expect(observers).toBe(0);
  });

  it("finishes at once when reduced motion is turned on mid-run", () => {
    render(<Stage />);
    intersect();
    advance(VERIFYING_AFTER_MS);
    expect(screen.getByText("verifying")).toBeInTheDocument();
    act(() => motionChanged?.({ matches: true }));
    expect(screen.getByText("verified")).toBeInTheDocument();
  });

  it("stays finished when an entry queued before reduced motion arrives after it", () => {
    render(<Stage />);
    act(() => motionChanged?.({ matches: true }));
    intersect(true, { queued: true });
    advance(VERIFYING_AFTER_MS);
    expect(screen.getByText("verified")).toBeInTheDocument();
  });

  it("shows the verified result when nothing could ever report it on screen", () => {
    // @ts-expect-error -- a browser without the API
    globalThis.IntersectionObserver = undefined;
    render(<Stage />);
    expect(screen.getByText("verified")).toBeInTheDocument();
  });
});
