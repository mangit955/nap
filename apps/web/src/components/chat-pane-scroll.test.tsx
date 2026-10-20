import type { StoredEvent } from "@nap/shared/ports/event-store";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatPane } from "./chat-pane.tsx";

const message: StoredEvent = {
  type: "agent.message",
  sessionId: "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f",
  turnId: "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f",
  seq: 1,
  createdAt: "2026-08-09T12:00:00.000Z",
  payload: { text: "A response to read while drafting." },
};

function show(props: Partial<Parameters<typeof ChatPane>[0]> = {}) {
  const view = render(<ChatPane events={[message]} {...props} />);
  const timeline = screen.getByRole("region", { name: "Conversation" });
  if (!(timeline instanceof HTMLElement)) throw new Error("Missing timeline");
  Object.defineProperties(timeline, {
    scrollHeight: { configurable: true, value: 1800 },
    clientHeight: { configurable: true, value: 600 },
    scrollTop: { configurable: true, writable: true, value: 1200 },
  });
  return { ...view, timeline, composer: screen.getByRole("group", { name: "Message composer" }) };
}

beforeEach(() => {
  const original = window.matchMedia;
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    ...original(query),
    matches: query === "(min-width: 768px)",
  }));
});
afterEach(() => vi.restoreAllMocks());

describe("the resting composer", () => {
  it("collapses after a deliberate wheel gesture, preserves the same draft and reading offset, and expands at the end", () => {
    const { timeline, composer } = show();
    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "Keep this draft" } });
    fireEvent.wheel(timeline, { deltaY: -12 });
    expect(composer).not.toHaveAttribute("data-resting", "true");
    fireEvent.wheel(timeline, { deltaY: -12 });
    expect(composer).toHaveAttribute("data-resting", "true");
    expect(screen.getByRole("textbox", { name: "Message" })).toBe(input);
    expect(input).toHaveValue("Keep this draft");
    expect(timeline.scrollTop).toBe(1200);
    timeline.scrollTop = 800;
    fireEvent.scroll(timeline);
    expect(screen.getByRole("button", { name: "Scroll to end" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Scroll to end" }));
    expect(timeline.scrollTop).toBe(1200);
    expect(composer).not.toHaveAttribute("data-resting", "true");
  });

  it("does not collapse for streaming scroll changes or a short transcript", () => {
    const { timeline, composer, rerender } = show();
    timeline.scrollTop = 900;
    fireEvent.scroll(timeline);
    rerender(<ChatPane events={[message, { ...message, seq: 2 }]} />);
    expect(composer).not.toHaveAttribute("data-resting", "true");
    Object.defineProperty(timeline, "scrollHeight", { value: 600 });
    timeline.scrollTop = 0;
    fireEvent.wheel(timeline, { deltaY: -90 });
    expect(composer).not.toHaveAttribute("data-resting", "true");
  });

  it("ignores zoom and a nested scrolling surface", () => {
    const { timeline, composer } = show();
    fireEvent.wheel(timeline, { deltaY: -80, ctrlKey: true });
    const output = document.createElement("div");
    output.style.overflowY = "auto";
    Object.defineProperties(output, {
      scrollHeight: { value: 500 },
      clientHeight: { value: 100 },
      scrollTop: { value: 100 },
    });
    timeline.append(output);
    fireEvent.wheel(output, { deltaY: -80 });
    expect(composer).not.toHaveAttribute("data-resting", "true");
  });

  it("expands for editing and suppresses the tail of the current gesture", () => {
    vi.useFakeTimers();
    try {
      const { timeline, composer } = show();
      fireEvent.wheel(timeline, { deltaY: -80 });
      expect(composer).toHaveAttribute("data-resting", "true");
      fireEvent.pointerDown(screen.getByRole("textbox", { name: "Message" }));
      expect(composer).not.toHaveAttribute("data-resting", "true");
      fireEvent.wheel(timeline, { deltaY: -80 });
      expect(composer).not.toHaveAttribute("data-resting", "true");
      act(() => vi.advanceTimersByTime(121));
      fireEvent.wheel(timeline, { deltaY: -80 });
      expect(composer).toHaveAttribute("data-resting", "true");
      fireEvent.change(screen.getByRole("textbox", { name: "Message" }), {
        target: { value: "Draft" },
      });
      expect(composer).not.toHaveAttribute("data-resting", "true");
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    { error: "Could not send. Try again." },
    { pending: "Queued request", pendingAfterCompaction: true },
  ])("keeps actionable composer details expanded: %j", (props) => {
    const { timeline, composer } = show(props);
    fireEvent.wheel(timeline, { deltaY: -80 });
    expect(composer).not.toHaveAttribute("data-resting", "true");
  });

  it("keeps multiline drafts and open menus expanded", () => {
    const { timeline, composer } = show();
    const input = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(input, { target: { value: "One\nTwo" } });
    fireEvent.wheel(timeline, { deltaY: -80 });
    expect(composer).not.toHaveAttribute("data-resting", "true");
    fireEvent.change(input, { target: { value: "/" } });
    fireEvent.wheel(timeline, { deltaY: -80 });
    expect(composer).not.toHaveAttribute("data-resting", "true");
  });

  it("retains the same context trigger and Stop button while resting", () => {
    const onCancel = vi.fn();
    const { timeline, composer } = show({ running: true, onCancel });
    const context = screen.getByLabelText(/^Context,/);
    fireEvent.wheel(timeline, { deltaY: -80 });
    expect(composer).toHaveAttribute("data-resting", "true");
    expect(screen.getByLabelText(/^Context,/)).toBe(context);
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it.each(["PageUp", "Home", "PageDown", "End"])(
    "collapses for timeline %s but never takes editing keys",
    (key) => {
      const { timeline, composer } = show();
      timeline.scrollTop = 600;
      fireEvent.keyDown(screen.getByRole("textbox", { name: "Message" }), { key });
      expect(composer).not.toHaveAttribute("data-resting", "true");
      fireEvent.keyDown(timeline, { key });
      expect(composer).toHaveAttribute("data-resting", "true");
      timeline.scrollTop = 1200;
      fireEvent.scroll(timeline);
      expect(composer).not.toHaveAttribute("data-resting", "true");
    },
  );

  it("does not refocus or expand after a turn finishes while reading", () => {
    const { timeline, composer, rerender } = show({ running: true });
    fireEvent.wheel(timeline, { deltaY: -80 });
    expect(composer).toHaveAttribute("data-resting", "true");
    rerender(<ChatPane events={[message]} running={false} />);
    expect(composer).toHaveAttribute("data-resting", "true");
    expect(screen.getByRole("textbox", { name: "Message" })).not.toHaveFocus();
  });

  it("keeps a context popup in place while resting and blocks collapse while it is open", () => {
    const { timeline, composer } = show();
    const context = screen.getByLabelText(/^Context,/);
    const details = context.closest("details");
    if (!(details instanceof HTMLDetailsElement)) throw new Error("Missing context disclosure");
    details.open = true;
    fireEvent.wheel(timeline, { deltaY: -80 });
    expect(composer).not.toHaveAttribute("data-resting", "true");
    details.open = false;
    fireEvent.wheel(timeline, { deltaY: -80 });
    expect(composer).toHaveAttribute("data-resting", "true");
    fireEvent.click(context);
    expect(details.open).toBe(true);
    expect(composer).toHaveAttribute("data-resting", "true");
  });

  it("keeps mobile layouts expanded", () => {
    vi.mocked(window.matchMedia).mockImplementation((query) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }));
    const { timeline, composer } = show();
    fireEvent.wheel(timeline, { deltaY: -80 });
    expect(composer).not.toHaveAttribute("data-resting", "true");
  });
});
