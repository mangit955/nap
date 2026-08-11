import { describe, expect, it } from "vitest";
import {
  ARC_MAX,
  ARC_MIN,
  hsl,
  PALETTE_PROPERTIES,
  rollPalette,
  type StyleTarget,
} from "./palette.ts";

/** A style target that records what was written to it, with no DOM behind it. */
function recorder(): StyleTarget & { written: Map<string, string> } {
  const written = new Map<string, string>();
  return {
    written,
    style: {
      setProperty(name: string, value: string) {
        written.set(name, value);
      },
    },
  };
}

/** The hue out of an `hsl()` string, so the arc can be measured rather than eyeballed. */
function hueOf(value: string): number {
  const match = /^hsl\((-?[\d.]+) /.exec(value);
  if (match === null) throw new Error(`not an hsl() string: ${value}`);
  return Number(match[1]);
}

describe("hsl", () => {
  it("wraps hues onto the wheel, in both directions", () => {
    expect(hsl(0, 100, 50)).toBe("hsl(0.0 100% 50%)");
    expect(hsl(420, 100, 50)).toBe("hsl(60.0 100% 50%)");
    expect(hsl(-30, 100, 50)).toBe("hsl(330.0 100% 50%)");
  });

  it("only emits an alpha channel when there is one", () => {
    expect(hsl(10, 90, 40)).toBe("hsl(10.0 90% 40%)");
    expect(hsl(10, 90, 40, 0.5)).toBe("hsl(10.0 90% 40% / 0.5)");
  });
});

describe("rollPalette", () => {
  it("writes every property the gradient reads", () => {
    const target = recorder();
    rollPalette(target, () => 0.5);

    for (const property of PALETTE_PROPERTIES) {
      expect(target.written.get(property), property).toMatch(/^hsl\(/);
    }
    // Nothing else: a stray property here is a value no stylesheet consumes.
    expect([...target.written.keys()].sort()).toEqual([...PALETTE_PROPERTIES].sort());
  });

  it("keeps every hue inside one arc of the anchor", () => {
    // `random()` is called for the anchor, the span and the direction, in that order.
    const draws = [0.25, 1, 0.9];
    let index = 0;
    const target = recorder();
    rollPalette(target, () => draws[index++] ?? 0);

    const anchor = 0.25 * 360;
    const hues = PALETTE_PROPERTIES.map((property) => hueOf(target.written.get(property) ?? ""));
    for (const hue of hues) {
      // Compared on the wheel, because a hue past 360 comes back wrapped.
      const delta = Math.min(
        Math.abs(hue - anchor),
        360 - Math.abs(hue - anchor),
        Math.abs(hue - anchor + 360),
        Math.abs(hue - anchor - 360),
      );
      expect(delta).toBeLessThanOrEqual(ARC_MAX + 1);
    }
  });

  it("runs the arc backwards for half of all rolls", () => {
    // Identical anchor and span; only the third draw — the direction — differs. Without that
    // branch both rolls land on the same hue and consecutive pulses would all walk one way.
    const roll = (direction: number) => {
      const draws = [0.25, 0.5, direction];
      let index = 0;
      const target = recorder();
      rollPalette(target, () => draws[index++] ?? 0);
      return hueOf(target.written.get("--ai-c5") ?? "");
    };

    expect(roll(0.1)).not.toBe(roll(0.9));
  });

  it("spans at least the minimum arc, so a roll is never one flat colour", () => {
    const target = recorder();
    rollPalette(target, () => 0);

    const first = hueOf(target.written.get("--ai-c1") ?? "");
    const last = hueOf(target.written.get("--ai-c6") ?? "");
    const delta = Math.abs(first - last);
    expect(Math.min(delta, 360 - delta)).toBeGreaterThanOrEqual(Math.min(ARC_MIN, 180) - 1);
  });
});
