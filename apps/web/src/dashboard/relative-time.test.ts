import { describe, expect, it } from "vitest";
import { relativeTime } from "./relative-time.ts";

describe("relativeTime", () => {
  const NOW = Date.parse("2026-08-09T12:00:00.000Z");

  it.each([
    ["2026-08-09T11:59:30.000Z", "just now"],
    ["2026-08-09T11:30:00.000Z", "30m ago"],
    ["2026-08-09T09:00:00.000Z", "3h ago"],
    ["2026-08-07T12:00:00.000Z", "2d ago"],
  ])("renders %s as %s", (iso, expected) => {
    expect(relativeTime(iso, NOW)).toBe(expected);
  });

  it("never renders a negative age", () => {
    // Clocks disagree: a card written by a server a second ahead would otherwise read "-1m ago".
    expect(relativeTime("2026-08-09T12:00:30.000Z", NOW)).toBe("just now");
  });
});
