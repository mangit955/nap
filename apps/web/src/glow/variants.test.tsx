import { describe, expect, it } from "vitest";
import { DARK_KEYS, radiusFor, VARIANTS, variantAt } from "./variants.tsx";

// `.tsx` because the module it tests exports components; the filename is what routes a test to
// the project that can compile JSX, whether or not the test itself contains any.

describe("variantAt", () => {
  it("wraps forever, in both directions", () => {
    expect(variantAt(0)).toBe(VARIANTS[0]);
    expect(variantAt(VARIANTS.length)).toBe(VARIANTS[0]);
    expect(variantAt(VARIANTS.length * 3 + 2)).toBe(VARIANTS[2]);
    expect(variantAt(-1)).toBe(VARIANTS[VARIANTS.length - 1]);
  });
});

describe("radiusFor", () => {
  it("resolves a pill to half the box it will occupy, never to an absurd number", () => {
    // A radius of 9999 interpolates numerically, so a morph away from it stays above the
    // browser's clamp for most of its duration and then snaps. Everything must be a real
    // number measured against a real box.
    expect(radiusFor({ ...stub, radius: "pill" }, 48)).toBe(24);
  });

  it("passes a fixed radius through", () => {
    expect(radiusFor({ ...stub, radius: 16 }, 48)).toBe(16);
  });
});

describe("the rotation", () => {
  it("changes polarity exactly once", () => {
    // One inverted surface is the biggest jump in the cycle; two would make it a flicker
    // between two themes rather than one moment of contrast.
    const inverted = VARIANTS.filter((variant) => DARK_KEYS.has(variant.key));
    expect(inverted).toHaveLength(1);
  });

  it("names only variants that exist", () => {
    // A key renamed on one side of this and not the other fails silently: the face simply
    // stops inverting, and nothing else changes.
    for (const key of DARK_KEYS) {
      expect(VARIANTS.map((variant) => variant.key)).toContain(key);
    }
  });

  it("ends on the shape the real input takes", () => {
    // The card settles out of its last variant, so the morph into the input is a change of
    // size rather than a change of kind.
    expect(VARIANTS[VARIANTS.length - 1]?.key).toBe("prompt");
  });
});

const stub = VARIANTS[0] ?? { key: "", radius: 0, pad: "", Content: () => <span /> };
