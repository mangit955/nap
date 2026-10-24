import type { HumanComputerAction } from "@nap/shared/computer-access";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ComputerInputSurface } from "./computer-input-surface.tsx";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});
function setup(driving = true) {
  const sendActions = vi.fn(async (_actions: readonly HumanComputerAction[]) => true);
  const takeControl = vi.fn(async () => true);
  const release = vi.fn();
  const props = {
    driving,
    available: true,
    sourceKey: "live-a",
    sendActions,
    takeControl,
    release,
  };
  const view = render(<ComputerInputSurface {...props} />);
  const input = screen.getByRole("textbox", { name: "Type on the remote computer" });
  vi.spyOn(input, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 20, 1000, 600));
  // jsdom schedules selectionchange when the hidden textbox receives focus.
  act(() => {
    vi.runOnlyPendingTimers();
  });
  return { ...view, input, sendActions, takeControl, release, props };
}
function click(input: HTMLElement, x: number, y: number, detail = 1) {
  fireEvent.click(input, { clientX: x, clientY: y, detail });
}
it("click anywhere acquires control without forwarding the activation gesture or duplicating application roles", () => {
  const h = setup(false);
  expect(screen.getByText("Click anywhere to drive the computer")).toBeVisible();
  expect(screen.queryByRole("application")).toBeNull();
  click(h.input, 510, 320);
  expect(h.takeControl).toHaveBeenCalledOnce();
  expect(h.sendActions).not.toHaveBeenCalled();
});
it("ignores letterbox and maps centered 1024 by 768 coordinates", () => {
  const h = setup();
  click(h.input, 50, 320);
  act(() => {
    vi.runAllTimers();
  });
  expect(h.sendActions).not.toHaveBeenCalled();
  click(h.input, 510, 320);
  act(() => {
    vi.runAllTimers();
  });
  expect(h.sendActions).toHaveBeenLastCalledWith([
    { action: "left_click", coordinate: [512, 384] },
  ]);
  click(h.input, 909, 619);
  act(() => {
    vi.runAllTimers();
  });
  expect(h.sendActions).toHaveBeenLastCalledWith([
    { action: "left_click", coordinate: [1022, 766] },
  ]);
});
it("a double click sends one double click, without two singles or a triple", () => {
  const h = setup();
  click(h.input, 510, 320, 1);
  click(h.input, 510, 320, 2);
  fireEvent.doubleClick(h.input, { clientX: 510, clientY: 320 });
  click(h.input, 510, 320, 3);
  act(() => {
    vi.runAllTimers();
  });
  expect(h.sendActions).toHaveBeenCalledExactlyOnceWith([
    { action: "double_click", coordinate: [512, 384] },
  ]);
});
it("sends right/middle click and bounded wheel input without local menu or clipboard reads", () => {
  const h = setup();
  fireEvent.contextMenu(h.input, { clientX: 510, clientY: 320 });
  fireEvent(
    h.input,
    new MouseEvent("auxclick", { bubbles: true, button: 1, clientX: 510, clientY: 320 }),
  );
  fireEvent.wheel(h.input, { clientX: 510, clientY: 320, deltaY: -100_000 });
  expect(h.sendActions.mock.calls.map(([actions]) => actions)).toStrictEqual([
    [{ action: "right_click", coordinate: [512, 384] }],
    [{ action: "middle_click", coordinate: [512, 384] }],
    [{ action: "scroll", coordinate: [512, 384], scroll_direction: "up", scroll_amount: 100 }],
  ]);
});
it("sends a whole drag only at release and cancels a gesture on pointer cancel", () => {
  const h = setup();
  // jsdom has no PointerEvent; preserve real mouse coordinates for these local events.
  vi.stubGlobal("PointerEvent", MouseEvent);
  fireEvent.pointerDown(h.input, { pointerId: 1, button: 0, clientX: 510, clientY: 320 });
  fireEvent.pointerMove(h.input, { pointerId: 1, buttons: 1, clientX: 710, clientY: 470 });
  expect(h.sendActions).not.toHaveBeenCalled();
  fireEvent.pointerUp(h.input, { pointerId: 1, button: 0, clientX: 710, clientY: 470 });
  click(h.input, 710, 470);
  act(() => {
    vi.runAllTimers();
  });
  expect(h.sendActions).toHaveBeenCalledExactlyOnceWith([
    { action: "left_click_drag", start_coordinate: [512, 384], coordinate: [768, 576] },
  ]);
  fireEvent.pointerDown(h.input, { button: 0, clientX: 510, clientY: 320 });
  fireEvent.pointerCancel(h.input);
  fireEvent.pointerUp(h.input, { button: 0, clientX: 710, clientY: 470 });
  expect(h.sendActions).toHaveBeenCalledOnce();
  vi.unstubAllGlobals();
});
it("uses keysyms for chords and special keys, leaves paste to its explicit event, and Shift Escape exits", () => {
  const h = setup();
  fireEvent.keyDown(h.input, { key: "a", ctrlKey: true });
  fireEvent.keyDown(h.input, { key: "ArrowLeft", altKey: true, shiftKey: true });
  fireEvent.keyDown(h.input, { key: "Escape" });
  fireEvent.keyDown(h.input, { key: "V", ctrlKey: true });
  fireEvent.keyDown(h.input, { key: "Shift", shiftKey: true });
  fireEvent.keyDown(h.input, { key: "Escape", shiftKey: true });
  expect(h.sendActions.mock.calls.map(([actions]) => actions)).toStrictEqual([
    [{ action: "key", text: "ctrl+a" }],
    [{ action: "key", text: "alt+shift+Left" }],
    [{ action: "key", text: "Escape" }],
  ]);
  expect(h.release).toHaveBeenCalledOnce();
});
it("ordinary text, touch input and IME commit once, without sending composing keys", () => {
  const h = setup();
  fireEvent.keyDown(h.input, { key: "a" });
  fireEvent.input(h.input, { target: { value: "a" }, inputType: "insertText", data: "a" });
  fireEvent.compositionStart(h.input);
  fireEvent.keyDown(h.input, { key: "Process", isComposing: true });
  fireEvent.input(h.input, {
    target: { value: "日本" },
    isComposing: true,
    inputType: "insertCompositionText",
  });
  fireEvent.compositionEnd(h.input, { data: "日本" });
  fireEvent.input(h.input, { target: { value: "日本" }, inputType: "insertText", data: "日本" });
  expect(h.sendActions.mock.calls.map(([actions]) => actions)).toStrictEqual([
    [{ action: "type", text: "a" }],
    [{ action: "type", text: "日本" }],
  ]);
});
it("explicit paste is bounded by shared batch/text limits and never repeats Ctrl V", () => {
  const h = setup();
  const text = "a".repeat(2001);
  fireEvent.keyDown(h.input, { key: "v", ctrlKey: true });
  fireEvent.paste(h.input, { clipboardData: { getData: () => text } });
  expect(h.sendActions).toHaveBeenCalledExactlyOnceWith([
    { action: "type", text: "a".repeat(2000) },
    { action: "type", text: "a" },
  ]);
});
it("cancels delayed clicks/composition on source changes, disable, blur and unmount", () => {
  const h = setup();
  click(h.input, 510, 320);
  h.rerender(<ComputerInputSurface {...h.props} sourceKey="live-b" />);
  act(() => {
    vi.runAllTimers();
  });
  expect(h.sendActions).not.toHaveBeenCalled();
  click(h.input, 510, 320);
  fireEvent.blur(h.input);
  act(() => {
    vi.runAllTimers();
  });
  expect(h.sendActions).not.toHaveBeenCalled();
  click(h.input, 510, 320);
  h.rerender(<ComputerInputSurface {...h.props} driving={false} available={false} />);
  act(() => {
    vi.runAllTimers();
  });
  expect(h.sendActions).not.toHaveBeenCalled();
  expect(h.input).toBeDisabled();
  h.unmount();
  expect(vi.getTimerCount()).toBe(0);
});

it("ignores an entire pointer gesture that starts in the letterbox", () => {
  const h = setup();
  vi.stubGlobal("PointerEvent", MouseEvent);
  fireEvent.pointerDown(h.input, { button: 0, clientX: 50, clientY: 320 });
  fireEvent.pointerMove(h.input, { buttons: 1, clientX: 510, clientY: 320 });
  fireEvent.pointerUp(h.input, { button: 0, clientX: 510, clientY: 320 });
  click(h.input, 510, 320);
  act(() => {
    vi.runAllTimers();
  });
  expect(h.sendActions).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
});
it("rejects oversized paste without a partial prefix, and keeps Unicode pairs intact", () => {
  const h = setup();
  fireEvent.paste(h.input, { clipboardData: { getData: () => "x".repeat(32_001) } });
  expect(h.sendActions).not.toHaveBeenCalled();
  expect(screen.getByRole("status")).toHaveTextContent("32,000");
  fireEvent.paste(h.input, { clipboardData: { getData: () => `${"a".repeat(1999)}🎉` } });
  expect(h.sendActions).toHaveBeenCalledExactlyOnceWith([
    { action: "type", text: "a".repeat(1999) },
    { action: "type", text: "🎉" },
  ]);
});
it("retires composition on source changes and removes the native wheel listener on unmount", () => {
  const h = setup();
  const remove = vi.spyOn(h.input, "removeEventListener");
  fireEvent.compositionStart(h.input);
  h.rerender(<ComputerInputSurface {...h.props} sourceKey="live-b" />);
  fireEvent.compositionEnd(h.input, { data: "stale" });
  expect(h.sendActions).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  click(h.input, 510, 320);
  h.unmount();
  expect(vi.getTimerCount()).toBe(0);
  expect(remove).toHaveBeenCalledWith("wheel", expect.any(Function));
});
it("Shift Insert delegates only to explicit paste, and typing flushes an earlier click", () => {
  const h = setup();
  click(h.input, 510, 320);
  fireEvent.keyDown(h.input, { key: "Insert", shiftKey: true });
  fireEvent.paste(h.input, { clipboardData: { getData: () => "once" } });
  act(() => {
    vi.runAllTimers();
  });
  expect(h.sendActions.mock.calls.map(([actions]) => actions)).toStrictEqual([
    [{ action: "left_click", coordinate: [512, 384] }],
    [{ action: "type", text: "once" }],
  ]);
});
