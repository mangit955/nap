import { type ComputerAction, ComputerActionSchema } from "@nap/shared/computer";

const actions = ComputerActionSchema.array().max(32);

export function computerActions(input: Record<string, unknown>): ComputerAction[] {
  const parsed = actions.safeParse(input.actions);
  return parsed.success ? parsed.data : [];
}

export function computerActionLabel(action: ComputerAction): string {
  switch (action.action) {
    case "left_click":
      return `Clicked at (${action.coordinate.join(", ")})`;
    case "double_click":
      return `Double-clicked at (${action.coordinate.join(", ")})`;
    case "triple_click":
      return `Triple-clicked at (${action.coordinate.join(", ")})`;
    case "right_click":
      return `Right-clicked at (${action.coordinate.join(", ")})`;
    case "middle_click":
      return `Middle-clicked at (${action.coordinate.join(", ")})`;
    case "type":
      return "Typed text";
    case "key":
      return `Pressed key ${action.text}`;
    case "hold_key":
      return "Held key";
    case "wait":
      return `Waited ${action.duration}s`;
    case "screenshot":
      return "Took screenshot";
    case "scroll":
      return `Scrolled ${action.scroll_direction} by ${action.scroll_amount}`;
    case "left_click_drag":
      return `Dragged from (${action.start_coordinate.join(", ")}) to (${action.coordinate.join(", ")})`;
    case "mouse_move":
      return `Moved mouse to (${action.coordinate.join(", ")})`;
    case "zoom":
      return "Zoomed region";
    case "read_dom":
      return "Read page DOM";
    case "console":
      return "Viewed browser console";
    case "left_mouse_down":
      return "Pressed left mouse button";
    case "left_mouse_up":
      return "Released left mouse button";
    case "cursor_position":
      return "Read cursor position";
    case "annotate":
      return `Recorded ${action.annotation.type.replaceAll("_", " ")}`;
  }
}
