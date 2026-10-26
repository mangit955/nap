import type { ComputerAction } from "@nap/shared/computer";
import { expect, it } from "vitest";
import { computerActionLabel, computerActions } from "./action-labels.ts";

it.each([
  [{ action: "left_click", coordinate: [1, 2] }, "Clicked at (1, 2)"],
  [{ action: "double_click", coordinate: [1, 2] }, "Double-clicked at (1, 2)"],
  [{ action: "triple_click", coordinate: [1, 2] }, "Triple-clicked at (1, 2)"],
  [{ action: "right_click", coordinate: [1, 2] }, "Right-clicked at (1, 2)"],
  [{ action: "middle_click", coordinate: [1, 2] }, "Middle-clicked at (1, 2)"],
  [{ action: "type", text: "never display this" }, "Typed text"],
  [{ action: "key", text: "ctrl+l" }, "Pressed key ctrl+l"],
  [{ action: "hold_key", text: "ctrl", duration: 1 }, "Held key"],
  [{ action: "wait", duration: 3 }, "Waited 3s"],
  [{ action: "screenshot" }, "Took screenshot"],
  [{ action: "scroll", scroll_direction: "down", scroll_amount: 3 }, "Scrolled down by 3"],
  [
    { action: "left_click_drag", start_coordinate: [1, 2], coordinate: [3, 4] },
    "Dragged from (1, 2) to (3, 4)",
  ],
  [{ action: "mouse_move", coordinate: [1, 2] }, "Moved mouse to (1, 2)"],
  [{ action: "zoom", region: [1, 2, 3, 4] }, "Zoomed region"],
  [{ action: "read_dom" }, "Read page DOM"],
  [{ action: "console" }, "Viewed browser console"],
  [{ action: "left_mouse_down" }, "Pressed left mouse button"],
  [{ action: "left_mouse_up" }, "Released left mouse button"],
  [{ action: "cursor_position" }, "Read cursor position"],
  [{ action: "annotate", annotation: { type: "setup", description: "prepare" } }, "Recorded setup"],
] satisfies [ComputerAction, string][])("labels %j", (action, label) =>
  expect(computerActionLabel(action)).toBe(label),
);
it("parses recorded action data and refuses malformed or oversized lists", () => {
  expect(computerActions({ actions: [{ action: "screenshot" }] })).toHaveLength(1);
  expect(computerActions({ actions: [{ action: "javascript", text: "bad" }] })).toEqual([]);
  expect(
    computerActions({ actions: Array.from({ length: 33 }, () => ({ action: "screenshot" })) }),
  ).toEqual([]);
});
