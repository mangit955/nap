import { VERSION } from "@nap/shared/version";
import { describe, expect, it } from "vitest";

// The point of this test is the import above, not the assertion below: it
// proves the test runner resolves a workspace package by its subpath export
// straight to TypeScript source, with no build step. Every later package
// depends on that working. See docs/PLAN.md M0-1.
describe("@nap/runtime", () => {
  it("resolves workspace imports from @nap/shared", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
