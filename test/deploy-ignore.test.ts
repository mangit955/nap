import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findUnanchoredPatterns } from "./deploy-ignore.ts";

const repoRoot = join(import.meta.dirname, "..");

describe("finding patterns that do not say what they mean", () => {
  it("rejects a bare name, which silently matches at every depth", () => {
    // The one that shipped: `docs` took `apps/web/src/app/docs` with it and 404'd the route.
    expect(findUnanchoredPatterns("docs\n")).toEqual([
      {
        line: 1,
        pattern: "docs",
        suggestion:
          'write "/docs" for the one at the repository root, or "**/docs" to mean every depth',
      },
    ]);
  });

  it("accepts a pattern anchored to the root", () => {
    expect(findUnanchoredPatterns("/docs\n/test\n")).toEqual([]);
  });

  it("accepts a pattern that says it means every depth", () => {
    expect(findUnanchoredPatterns("**/node_modules\n")).toEqual([]);
  });

  it("accepts a path, which is already relative to the file", () => {
    expect(findUnanchoredPatterns("apps/web/.next\n")).toEqual([]);
  });

  it("judges a negation on the pattern rather than the bang", () => {
    // `!docs` is as ambiguous as `docs`, and re-including a directory at every depth by accident
    // is the same class of surprise in the other direction.
    expect(findUnanchoredPatterns("!docs\n").map((v) => v.pattern)).toEqual(["!docs"]);
    expect(findUnanchoredPatterns("!/docs\n")).toEqual([]);
  });

  it("ignores comments and blank lines", () => {
    expect(findUnanchoredPatterns("# docs\n\n   \n/docs\n")).toEqual([]);
  });

  it("reports every offender, not just the first", () => {
    expect(findUnanchoredPatterns("docs\n/test\ninfra\n").map((v) => v.line)).toEqual([1, 3]);
  });
});

describe("the real .vercelignore", () => {
  it("says what every one of its patterns means", () => {
    const contents = readFileSync(join(repoRoot, ".vercelignore"), "utf8");

    expect(findUnanchoredPatterns(contents)).toEqual([]);
  });

  it("does not exclude the web app's own source", () => {
    // The property that actually matters, asserted directly: whatever the patterns are, none of
    // them may name a directory inside `apps/web/src`. A route that never reaches the build is a
    // green deployment serving a 404.
    const contents = readFileSync(join(repoRoot, ".vercelignore"), "utf8");
    const patterns = contents
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"));

    for (const pattern of patterns) {
      expect(pattern.startsWith("/apps/web/src")).toBe(false);
      // A recursive pattern is the dangerous kind: `**/docs` would reach into the app too. Only
      // build artefacts are allowed to be recursive, because they exist at every depth by nature.
      if (pattern.startsWith("**/")) {
        expect(["**/node_modules", "**/.next", "**/.turbo"]).toContain(pattern);
      }
    }
  });
});
