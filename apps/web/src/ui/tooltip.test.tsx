import { act, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TOOLTIP_DELAY_MS, Tooltip } from "./tooltip.tsx";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** A mouse coming to rest on the control, the way Base UI's hover listens for it. */
function rest(element: Element) {
  fireEvent.pointerEnter(element, { pointerType: "mouse" });
  fireEvent.mouseEnter(element);
  fireEvent.mouseMove(element);
}
const wait = (ms: number) => act(() => vi.advanceTimersByTime(ms));

describe("Tooltip", () => {
  it("draws the label once the pointer has rested for the delay, and not before", async () => {
    render(
      <Tooltip label="New session">
        <button type="button" aria-label="New session" />
      </Tooltip>,
    );
    rest(screen.getByRole("button", { name: "New session" }));
    await wait(TOOLTIP_DELAY_MS - 50);
    expect(screen.queryByText("New session")).toBeNull();
    await wait(100);
    expect(screen.getByText("New session")).toBeInTheDocument();
  });

  it("opens on keyboard focus with no wait", async () => {
    render(
      <Tooltip label="Help">
        <a href="/docs" aria-label="Help">
          ?
        </a>
      </Tooltip>,
    );
    fireEvent.keyDown(document.body, { key: "Tab" });
    act(() => screen.getByRole("link", { name: "Help" }).focus());
    await wait(0);
    expect(screen.getByText("Help")).toBeInTheDocument();
  });

  it("keeps the control as it was: its name, its element, its ref and its click", () => {
    const ref = createRef<HTMLButtonElement>();
    const onClick = vi.fn();
    render(
      <Tooltip label="Settings">
        <button ref={ref} type="button" aria-label="Settings" onClick={onClick} />
      </Tooltip>,
    );
    const button = screen.getByRole("button", { name: "Settings" });
    expect(ref.current).toBe(button);
    expect(button).not.toHaveAttribute("title");
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });

  it("draws a shortcut only when it is given one", async () => {
    const { rerender } = render(
      <Tooltip label="Search">
        <button type="button" aria-label="Search" />
      </Tooltip>,
    );
    rest(screen.getByRole("button", { name: "Search" }));
    await wait(TOOLTIP_DELAY_MS);
    expect(document.querySelector("kbd")).toBeNull();
    rerender(
      <Tooltip label="Search" shortcut="⌘K">
        <button type="button" aria-label="Search" />
      </Tooltip>,
    );
    expect(document.querySelector("kbd")).toHaveTextContent("⌘K");
  });

  it("stays shut while disabled, as over a control's own open menu", async () => {
    render(
      <Tooltip label="Filter by source" disabled>
        <button type="button" aria-label="Filter by source" />
      </Tooltip>,
    );
    rest(screen.getByRole("button", { name: "Filter by source" }));
    await wait(TOOLTIP_DELAY_MS * 2);
    expect(screen.queryByText("Filter by source")).toBeNull();
  });

  it("does not open for a finger, which has no hover to rest", async () => {
    render(
      <Tooltip label="Snooze">
        <button type="button" aria-label="Snooze" />
      </Tooltip>,
    );
    const button = screen.getByRole("button", { name: "Snooze" });
    fireEvent.pointerEnter(button, { pointerType: "touch" });
    fireEvent.pointerDown(button, { pointerType: "touch" });
    fireEvent.mouseEnter(button);
    fireEvent.mouseMove(button);
    await wait(TOOLTIP_DELAY_MS * 2);
    expect(screen.queryByText("Snooze")).toBeNull();
  });
});
