import { describe, expect, it } from "vitest";
import { VERSION } from "./version.ts";

describe("@nap/shared", () => {
  it("exposes a semver version string", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
