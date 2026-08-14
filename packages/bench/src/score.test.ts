import { describe, expect, it } from "vitest";
import type { CheckResult } from "./report.ts";
import { scoreChecks } from "./score.ts";

function result(id: string, passed: boolean): CheckResult {
  return { checkId: id, kind: "command", passed, detail: passed ? "exit 0" : "exit 1" };
}

describe("scoreChecks", () => {
  it("is 100 when every check passed", () => {
    expect(scoreChecks([result("a", true), result("b", true)])).toBe(100);
  });

  it("is 0 when none did", () => {
    expect(scoreChecks([result("a", false)])).toBe(0);
  });

  it("is the proportion that passed", () => {
    expect(scoreChecks([result("a", true), result("b", false)])).toBe(50);
    expect(scoreChecks([result("a", true), result("b", true), result("c", false)])).toBe(67);
  });

  it("is 0 for no checks rather than 100", () => {
    // Dividing by zero would be NaN, and "everything asked of it passed" is the wrong
    // reading of a run that was asked nothing. A task with no checks cannot be parsed,
    // so this is defence against a caller assembling results by hand.
    expect(scoreChecks([])).toBe(0);
  });

  it("is a whole number, so a report never carries floating-point noise", () => {
    expect(
      Number.isInteger(scoreChecks([result("a", true), result("b", false), result("c", false)])),
    ).toBe(true);
  });
});
