import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkingIndicator } from "./working-indicator.tsx";

/**
 * The grid is colour and movement, so almost none of this asserts on how it looks — that is
 * checked in a browser, like every other effect in this app. What is worth pinning is the part
 * that would break silently: the accessible name, which must stay one static phrase however
 * fast the timer ticks, and the interval, which must be cleared.
 */

const START = Date.parse("2026-08-09T12:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("WorkingIndicator", () => {
  it("announces itself once, as a status", () => {
    render(<WorkingIndicator label="Reading App.tsx" />);

    expect(screen.getByRole("status", { name: "Agent is working" })).toBeInTheDocument();
  });

  it("keeps every moving part out of the accessibility tree", () => {
    // This is a live region that changes ten times a second. Nothing inside it may be
    // announced: the timer would re-announce on every tick, and the label repeats the step
    // line above, which already carries its own `still running`. The name is an `aria-label`,
    // so it stays the same phrase however fast the contents change.
    const { container } = render(<WorkingIndicator label="Running bun install" />);
    const status = screen.getByRole("status", { name: "Agent is working" });

    act(() => vi.advanceTimersByTime(4300));

    expect(screen.getByRole("status", { name: "Agent is working" })).toBeInTheDocument();
    // Every child of the status, not merely some of them — a fourth part added later without
    // one would start announcing on its own.
    const children = [...status.children];
    expect(children).toHaveLength(3);
    for (const child of children) expect(child).toHaveAttribute("aria-hidden", "true");

    expect(container.textContent).toContain("Running bun install");
  });

  it("shows the label it was given", () => {
    const { container } = render(<WorkingIndicator label="Writing Counter.tsx" />);

    expect(container.textContent).toContain("Writing Counter.tsx");
  });

  it("counts from the moment it appeared when no turn has been acknowledged", () => {
    const { container } = render(<WorkingIndicator label="Starting up" />);

    act(() => vi.advanceTimersByTime(2400));

    expect(container.textContent).toContain("2.4s");
  });

  it("counts from the turn's own start, so a reload mid-turn resumes the count", () => {
    // The anchor is the server's timestamp on `turn.started`. Mount time would restart at zero
    // on every reload and disagree with the `Done · 12.4s` line that replaces this.
    const startedAt = new Date(START - 12_000).toISOString();
    const { container } = render(<WorkingIndicator label="Thinking" startedAt={startedAt} />);

    expect(container.textContent).toContain("12.0s");

    act(() => vi.advanceTimersByTime(400));
    expect(container.textContent).toContain("12.4s");
  });

  it("switches to minutes once a turn passes one", () => {
    const startedAt = new Date(START - 65_300).toISOString();
    render(<WorkingIndicator label="Thinking" startedAt={startedAt} />);

    expect(screen.getByRole("status").textContent).toContain("1m 5.3s");
  });

  it("never shows a negative time when the server's clock is ahead of ours", () => {
    const { container } = render(
      <WorkingIndicator label="Thinking" startedAt={new Date(START + 30_000).toISOString()} />,
    );

    expect(container.textContent).toContain("0.0s");
    expect(container.textContent).not.toContain("-");
  });

  it("clears its interval when it goes away", () => {
    // Asserted on the resource rather than on the screen: a component that stops rendering
    // still leaks a 10Hz timer, and nothing visible would say so.
    const { unmount } = render(<WorkingIndicator label="Thinking" />);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
