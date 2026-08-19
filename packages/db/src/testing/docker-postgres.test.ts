import { describe, expect, it } from "vitest";
import { portFrom } from "./docker-postgres.ts";

describe("portFrom", () => {
  it("reads the published port off a single mapping", () => {
    expect(portFrom("0.0.0.0:55003\n")).toBe(55003);
  });

  it("reads it when docker also published the mapping on IPv6", () => {
    // Two lines is the ordinary output on a machine with both stacks, and both name the same
    // port — so taking the last is as good as taking the first, and neither may throw.
    expect(portFrom("0.0.0.0:55003\n[::]:55003\n")).toBe(55003);
  });

  it("says what it could not read rather than handing back a NaN port", () => {
    expect(() => portFrom("")).toThrow(/could not read a published port/);
  });
});
