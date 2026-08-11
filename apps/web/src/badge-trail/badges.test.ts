import { describe, expect, it } from "vitest";
import { COLORS, makeHueWalker, shuffle, WORDS } from "./badges.ts";

describe("makeHueWalker", () => {
  it("never hands back the same colour twice in a row, at any intensity", () => {
    // The reason the walk exists: picking at random from a palette puts two greens side by side
    // often enough that the trail reads as one smeared shape rather than a sequence of badges.
    const next = makeHueWalker(0);
    let previous = next(1);
    for (let i = 0; i < 200; i++) {
      const colour = next(i % 3 === 0 ? 0 : 1);
      expect(colour).not.toBe(previous);
      previous = colour;
    }
  });

  it("gets louder as the cursor moves faster", () => {
    // Two walkers on the same seed so only intensity differs — a slow drift should lay down a
    // paler badge than a flick does.
    expect(luminance(makeHueWalker(120)(0))).toBeGreaterThan(luminance(makeHueWalker(120)(1)));
  });

  it("returns a hex colour", () => {
    const next = makeHueWalker(0);
    for (let i = 0; i < 30; i++) expect(next(i / 30)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

describe("shuffle", () => {
  it("keeps every item exactly once, so the bag cannot lose or duplicate a word", () => {
    const bag = shuffle(WORDS, Math.random);
    expect([...bag].sort()).toEqual([...WORDS].sort());
  });

  it("does not reorder the caller's array", () => {
    const source = [...COLORS];
    shuffle(source, Math.random);
    expect(source).toEqual([...COLORS]);
  });

  it("actually reorders", () => {
    // A shuffle that returned its input would pass every assertion above it.
    const orders = new Set(Array.from({ length: 20 }, () => shuffle(WORDS, Math.random).join()));
    expect(orders.size).toBeGreaterThan(1);
  });
});

function luminance(hex: string): number {
  const value = Number.parseInt(hex.slice(1), 16);
  return ((value >> 16) & 0xff) * 0.299 + ((value >> 8) & 0xff) * 0.587 + (value & 0xff) * 0.114;
}
