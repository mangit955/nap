import { RESULTS_DIR } from "@nap/bench/results-dir";
import { describe, expect, it } from "vitest";
import { resolveResultsDir } from "./results-dir.ts";

describe("resolveResultsDir", () => {
  it("places the results directory under the repository root", () => {
    expect(resolveResultsDir("/repo")).toBe(`/repo/${RESULTS_DIR}`);
  });

  it("normalises a trailing separator rather than doubling it", () => {
    expect(resolveResultsDir("/repo/")).toBe(`/repo/${RESULTS_DIR}`);
  });
});
