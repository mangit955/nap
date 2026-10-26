import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProductStory } from "./product-story.tsx";

afterEach(() => vi.restoreAllMocks());

function reducedMotion() {
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    matches: query.includes("prefers-reduced-motion"),
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: () => true,
  }));
}

describe("the product story without scroll motion", () => {
  it("lets a visitor reach every chapter with the tabs", () => {
    reducedMotion();
    render(<ProductStory />);
    expect(screen.getByRole("tabpanel", { name: /describe/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /build & check/i }));
    expect(screen.getByRole("tabpanel", { name: /build & check/i })).toBeInTheDocument();
    expect(screen.queryByRole("tabpanel", { name: /describe/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: /come back/i }));
    expect(screen.getByRole("tabpanel", { name: /come back/i })).toBeInTheDocument();
  });

  it("supports arrow keys, Home and End with focus following the selected tab", () => {
    reducedMotion();
    render(<ProductStory />);
    const first = screen.getByRole("tab", { name: /describe/i });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    const build = screen.getByRole("tab", { name: /build & check/i });
    expect(build).toHaveFocus();
    expect(build).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(build, { key: "End" });
    const last = screen.getByRole("tab", { name: /come back/i });
    expect(last).toHaveFocus();
    fireEvent.keyDown(last, { key: "Home" });
    expect(first).toHaveFocus();
  });
});

function fromDemo(type: "ready" | "build" | "interact") {
  const frame = screen.getByTitle<HTMLIFrameElement>("Interactive Nap desktop walkthrough");
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        source: frame.contentWindow,
        data: { source: "nap-story-demo", type },
      }),
    );
  });
}

function visibleFrame() {
  vi.stubGlobal(
    "IntersectionObserver",
    class implements IntersectionObserver {
      root = null;
      rootMargin = "0px";
      scrollMargin = "0px";
      thresholds = [0.55];
      constructor(private callback: IntersectionObserverCallback) {}
      observe(target: Element) {
        const rect = target.getBoundingClientRect();
        this.callback(
          [
            {
              target,
              isIntersecting: true,
              intersectionRatio: 1,
              boundingClientRect: rect,
              intersectionRect: rect,
              rootBounds: null,
              time: 0,
            },
          ],
          this,
        );
      }
      unobserve() {}
      disconnect() {}
      takeRecords() {
        return [];
      }
    },
  );
}

describe("the product walkthrough", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("plays through once and leaves the finished app available", () => {
    visibleFrame();
    vi.useFakeTimers();
    render(<ProductStory />);
    fromDemo("ready");
    expect(screen.getByRole("button", { name: "Pause the walkthrough" })).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(2100);
    });
    expect(screen.getByRole("tabpanel", { name: /build & check/i })).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(2800);
    });
    expect(screen.getByRole("tabpanel", { name: /come back/i })).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(20000);
    });
    expect(screen.getByRole("tabpanel", { name: /come back/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Replay the walkthrough" })).toBeInTheDocument();
  });

  it("pauses and resumes without changing chapters while paused", () => {
    visibleFrame();
    vi.useFakeTimers();
    render(<ProductStory />);
    fromDemo("ready");
    fireEvent.click(screen.getByRole("button", { name: "Pause the walkthrough" }));
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(screen.getByRole("tabpanel", { name: /describe/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Play the walkthrough" }));
    act(() => {
      vi.advanceTimersByTime(2100);
    });
    expect(screen.getByRole("tabpanel", { name: /build & check/i })).toBeInTheDocument();
  });

  it("keeps reduced-motion visitors in control of the steps", () => {
    reducedMotion();
    visibleFrame();
    vi.useFakeTimers();
    render(<ProductStory />);
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(screen.getByRole("tabpanel", { name: /describe/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Pause the walkthrough" })).not.toBeInTheDocument();
  });

  it("keeps the native app mounted when inspecting steps and remounts it for replay", () => {
    reducedMotion();
    render(<ProductStory />);
    const frame = screen.getByTitle("Interactive Nap desktop walkthrough");
    fireEvent.click(screen.getByRole("tab", { name: /come back/i }));
    expect(screen.getByTitle("Interactive Nap desktop walkthrough")).toBe(frame);
    fireEvent.click(screen.getByRole("button", { name: "Replay the walkthrough" }));
    expect(screen.getByTitle("Interactive Nap desktop walkthrough")).not.toBe(frame);
    expect(screen.getByRole("tabpanel", { name: /describe/i })).toBeInTheDocument();
  });

  it("starts the build when the real dashboard composer sends its prompt", () => {
    reducedMotion();
    render(<ProductStory />);
    fromDemo("build");
    expect(screen.getByRole("tabpanel", { name: /build & check/i })).toBeInTheDocument();
  });

  it("waits for the actual app to load before advancing the walkthrough", () => {
    visibleFrame();
    vi.useFakeTimers();
    render(<ProductStory />);
    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(screen.getByRole("tabpanel", { name: /describe/i })).toBeInTheDocument();
    fromDemo("ready");
    act(() => {
      vi.advanceTimersByTime(2100);
    });
    expect(screen.getByRole("tabpanel", { name: /build & check/i })).toBeInTheDocument();
  });
});

it("switches example threads without reloading the native desktop", () => {
  reducedMotion();
  render(<ProductStory />);
  const frame = screen.getByTitle<HTMLIFrameElement>("Interactive Nap desktop walkthrough");
  const initialSource = frame.getAttribute("src");
  const target = frame.contentWindow;
  if (!target) throw new Error("Desktop iframe is missing its window");
  const post = vi.spyOn(target, "postMessage");
  fireEvent.click(screen.getByRole("button", { name: "Bookings" }));
  expect(post).toHaveBeenCalledWith(
    { source: "nap-story-demo", type: "select-thread", threadId: "cabins" },
    window.location.origin,
  );
  act(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        source: frame.contentWindow,
        data: {
          source: "nap-story-demo",
          type: "thread-selected",
          threadId: "cabins",
          chapter: "ready",
        },
      }),
    ),
  );
  expect(screen.getByRole("button", { name: "Bookings" })).toHaveAttribute("aria-pressed", "true");
  expect(screen.getByRole("tab", { name: /come back/i })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByTitle("Interactive Nap desktop walkthrough")).toBe(frame);
  expect(frame).toHaveAttribute("src", initialSource);
});

it("reflects a native sidebar selection and stops automatic progression", () => {
  visibleFrame();
  vi.useFakeTimers();
  try {
    render(<ProductStory />);
    fromDemo("ready");
    const frame = screen.getByTitle<HTMLIFrameElement>("Interactive Nap desktop walkthrough");
    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          source: frame.contentWindow,
          data: {
            source: "nap-story-demo",
            type: "thread-selected",
            threadId: "launch",
            chapter: "build",
          },
        }),
      ),
    );
    act(() => vi.advanceTimersByTime(10000));
    expect(screen.getByRole("button", { name: "Launch" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("tab", { name: /build & check/i })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.queryByRole("button", { name: "Pause the walkthrough" })).not.toBeInTheDocument();
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});
