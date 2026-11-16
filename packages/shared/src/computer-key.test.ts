import { describe, expect, it } from "vitest";
import { normalizeKeyChord } from "./computer-key.ts";

describe("normalizeKeyChord", () => {
  it.each([
    ["CTRL+A", "CTRL+a"],
    ["Ctrl+A", "Ctrl+a"],
    ["ctrl+shift+T", "ctrl+shift+t"],
    ["ALT+F", "ALT+f"],
  ])("lowercases the letter a modifier chord ends on: %s", (chord, expected) => {
    // xdotool reads an uppercase letter as Shift plus that letter, so CTRL+A is sent as
    // Ctrl+Shift+A, which Chrome does not treat as select-all. Shift, when meant, is named.
    expect(normalizeKeyChord(chord)).toBe(expected);
  });

  it.each(["A", "a", "Return", "ctrl+Return", "ctrl+F5", "BACKSPACE", "ctrl+a"])(
    "leaves %s alone",
    (chord) => {
      expect(normalizeKeyChord(chord)).toBe(chord);
    },
  );
});
