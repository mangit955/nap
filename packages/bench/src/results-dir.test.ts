import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RESULTS_DIR } from "./results-dir.ts";

const repoRoot = join(import.meta.dirname, "../../..");

describe("the results directory", () => {
  it("is relative to the repository root, so nothing here resolves a path", () => {
    expect(RESULTS_DIR).not.toContain("/");
    expect(RESULTS_DIR).not.toBe("");
  });

  it("is ignored by git, so running the benchmark cannot dirty the tree", () => {
    // The constant and .gitignore are two statements of the same fact, and nothing at
    // runtime notices when they drift — the first benchmark run would simply leave the
    // tree dirty. This is the only thing keeping them together.
    //
    // A repo-wide agreement like this would normally live in test/, beside the one about
    // the project root. It cannot: a test there may only import a workspace package the
    // *root* package.json depends on, and the root does not depend on this one.
    const patterns = readFileSync(join(repoRoot, ".gitignore"), "utf8")
      .split("\n")
      .map((line) => line.trim().replace(/\/$/, ""));

    expect(patterns).toContain(RESULTS_DIR);
  });
});
