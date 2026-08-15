/**
 * The named sizes, and the two facts about them anything else depends on: mobile is the narrow
 * one, and the default is desktop.
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_VIEWPORT_NAME,
  VIEWPORT_NAMES,
  VIEWPORT_SIZES,
  ViewportNameSchema,
  viewportNameForSize,
  viewportSize,
} from "./viewport.ts";

describe("viewports", () => {
  it("has a size for every name it offers", () => {
    for (const name of VIEWPORT_NAMES) {
      expect(viewportSize(name).width).toBeGreaterThan(0);
      expect(viewportSize(name).height).toBeGreaterThan(0);
    }
  });

  it("orders the names by width, which is what a responsive check assumes", () => {
    // A task that asserts no overflow at mobile and then at desktop is relying on this being
    // a widening sequence rather than three unrelated numbers.
    const widths = VIEWPORT_NAMES.map((name) => VIEWPORT_SIZES[name].width);
    expect(widths).toEqual([...widths].sort((a, b) => a - b));
  });

  it("defaults to desktop", () => {
    expect(DEFAULT_VIEWPORT_NAME).toBe("desktop");
  });

  it("refuses a size nobody named", () => {
    // Pixels in a task file would make two tasks' idea of "a phone" quietly different.
    expect(ViewportNameSchema.safeParse("375px").success).toBe(false);
  });
});

describe("viewportNameForSize", () => {
  it("names a size that is one of ours", () => {
    expect(viewportNameForSize({ width: 375, height: 667 })).toBe("mobile");
    expect(viewportNameForSize({ width: 768, height: 1024 })).toBe("tablet");
    expect(viewportNameForSize({ width: 1280, height: 800 })).toBe("desktop");
  });

  it("is undefined for a size that is none of them", () => {
    // The whole reason it exists: a screenshot taken at 800×900 must not be filed as `mobile`.
    // A caller with no name still has the numbers; one with the wrong name has neither.
    expect(viewportNameForSize({ width: 800, height: 900 })).toBeUndefined();
  });

  it("requires both dimensions to match, not just the width", () => {
    // Width alone is what an overflow assertion cares about, but a screenshot is the whole page.
    expect(viewportNameForSize({ width: 375, height: 900 })).toBeUndefined();
  });

  it("round-trips every name through its own size", () => {
    for (const name of VIEWPORT_NAMES) {
      expect(viewportNameForSize(viewportSize(name))).toBe(name);
    }
  });
});
