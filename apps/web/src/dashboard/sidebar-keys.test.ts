import { describe, expect, it } from "vitest";
import { adjacentId, opensMenu, shortcutCommand, showsJumpHints } from "./sidebar-keys.ts";

const key = (init: Partial<KeyboardEventInit> & { key: string; code?: string }) => ({
  key: init.key,
  code: init.code ?? "",
  metaKey: init.metaKey ?? false,
  ctrlKey: init.ctrlKey ?? false,
  shiftKey: init.shiftKey ?? false,
  altKey: init.altKey ?? false,
});

describe("shortcutCommand", () => {
  it("jumps with the platform's modifier and a digit", () => {
    expect(shortcutCommand(key({ key: "3", code: "Digit3", metaKey: true }), true)).toEqual({
      kind: "jump",
      index: 2,
    });
    expect(shortcutCommand(key({ key: "1", code: "Digit1", ctrlKey: true }), false)).toEqual({
      kind: "jump",
      index: 0,
    });
    // Ctrl on a Mac is not the modifier, and 0 is not a row.
    expect(shortcutCommand(key({ key: "1", code: "Digit1", ctrlKey: true }), true)).toBeNull();
    expect(shortcutCommand(key({ key: "0", code: "Digit0", metaKey: true }), true)).toBeNull();
  });

  it("steps to the next or previous session on mod+shift+] and [, whatever the layout prints", () => {
    expect(
      shortcutCommand(key({ key: "}", code: "BracketRight", metaKey: true, shiftKey: true }), true),
    ).toEqual({ kind: "step", direction: 1 });
    expect(
      shortcutCommand(key({ key: "{", code: "BracketLeft", ctrlKey: true, shiftKey: true }), false),
    ).toEqual({ kind: "step", direction: -1 });
    expect(
      shortcutCommand(key({ key: "]", code: "BracketRight", metaKey: true }), true),
    ).toBeNull();
  });
});

describe("showsJumpHints", () => {
  it("is the platform modifier held on its own", () => {
    expect(showsJumpHints(key({ key: "Meta", metaKey: true }), true)).toBe(true);
    expect(showsJumpHints(key({ key: "Control", ctrlKey: true }), false)).toBe(true);
    expect(showsJumpHints(key({ key: "Meta", metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(showsJumpHints(key({ key: "Shift" }), true)).toBe(false);
  });
});

describe("opensMenu", () => {
  it("is the Context Menu key or Shift+F10", () => {
    expect(opensMenu(key({ key: "ContextMenu" }))).toBe(true);
    expect(opensMenu(key({ key: "F10", shiftKey: true }))).toBe(true);
    expect(opensMenu(key({ key: "F10" }))).toBe(false);
  });
});

describe("adjacentId", () => {
  it("steps through the list, from either end when nothing is open, and stops at the ends", () => {
    expect(adjacentId(["a", "b", "c"], "b", 1)).toBe("c");
    expect(adjacentId(["a", "b", "c"], "b", -1)).toBe("a");
    expect(adjacentId(["a", "b", "c"], undefined, 1)).toBe("a");
    expect(adjacentId(["a", "b", "c"], undefined, -1)).toBe("c");
    expect(adjacentId(["a", "b", "c"], "c", 1)).toBeUndefined();
    expect(adjacentId([], undefined, 1)).toBeUndefined();
  });
});
