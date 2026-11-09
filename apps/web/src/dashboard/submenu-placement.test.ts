import { describe, expect, it } from "vitest";
import { placeSubmenu } from "./submenu-placement.ts";

const submenu = { width: 224, height: 176 };
const desktop = { width: 900, height: 720 };
const phone = { width: 390, height: 844 };
const owner = (left: number, top: number, width = 232, height = 30) => ({
  left,
  right: left + width,
  top,
  bottom: top + height,
});

describe("placeSubmenu", () => {
  it("goes on the right where there is room, risen so its first item lines up", () => {
    expect(placeSubmenu(owner(100, 200), submenu, desktop)).toEqual({ left: 232, top: -4 });
  });

  it("goes on the left where only the left has room", () => {
    expect(placeSubmenu(owner(600, 200), submenu, desktop)).toEqual({ left: -224, top: -4 });
  });

  it("drops below its owner where neither side has room, as on a phone", () => {
    expect(placeSubmenu(owner(12, 200), submenu, phone)).toEqual({ left: 0, top: 30 });
    // Pulled back from the right edge: 390 - 8 - 224 is the furthest right it can start.
    expect(placeSubmenu(owner(170, 200), submenu, phone)).toEqual({ left: 158 - 170, top: 30 });
  });

  it("ends at its owner's top instead, when there is no room under it", () => {
    expect(placeSubmenu(owner(12, 700), submenu, phone)).toEqual({ left: 0, top: -176 });
  });

  it("rises to stay on screen beside an owner near the bottom", () => {
    // 720 - 8 - 176 is the lowest top that keeps it on screen.
    expect(placeSubmenu(owner(100, 650), submenu, desktop)).toEqual({ left: 232, top: 536 - 650 });
  });

  it("never goes above the top edge, even when it is taller than the screen", () => {
    expect(
      placeSubmenu(owner(100, 20), { width: 224, height: 900 }, desktop).top + 20,
    ).toBeGreaterThanOrEqual(8);
  });
});
