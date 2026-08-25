import { RESULTS_DIR } from "@nap/bench/results-dir";
import { describe, expect, it } from "vitest";
import { RESULTS_DIR_ENV, resolveResultsDir } from "./results-dir.ts";

describe("resolveResultsDir", () => {
  it("places the results directory under the repository root", () => {
    expect(resolveResultsDir("/repo")).toBe(`/repo/${RESULTS_DIR}`);
  });

  it("normalises a trailing separator rather than doubling it", () => {
    expect(resolveResultsDir("/repo/")).toBe(`/repo/${RESULTS_DIR}`);
  });

  it("writes where the environment says, when it says anywhere", () => {
    expect(resolveResultsDir("/repo", { [RESULTS_DIR_ENV]: "/jobs/trial-1/agent" })).toBe(
      "/jobs/trial-1/agent",
    );
  });

  it("resolves a relative override against the repository, not the working directory", () => {
    expect(resolveResultsDir("/repo", { [RESULTS_DIR_ENV]: "tmp/job" })).toBe("/repo/tmp/job");
  });

  it("ignores an override that is set to nothing", () => {
    expect(resolveResultsDir("/repo", { [RESULTS_DIR_ENV]: "" })).toBe(`/repo/${RESULTS_DIR}`);
  });
});
