import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findUnanchoredPatterns, isIgnored } from "./deploy-ignore.ts";

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

describe("the real .dockerignore", () => {
  const contents = () => readFileSync(join(repoRoot, ".dockerignore"), "utf8");

  // Every one of these ends up inside the image if it is not excluded, and Bun loads all of them
  // at startup — where they outrank the platform's own variables. The `.local` pair is not
  // hypothetical: this repository has a `.env.local` holding a Vercel OIDC token, and it was being
  // copied into every build until an image was opened and read.
  it.each([
    ".env",
    ".env.local",
    ".env.production",
    ".env.production.local",
    "apps/api/.env",
    "apps/web/.env.local",
  ])("keeps %s out of the image", (path) => {
    expect(isIgnored(contents(), path)).toBe(true);
  });

  it("keeps the example, which is documentation and holds nothing", () => {
    expect(isIgnored(contents(), "apps/api/.env.example")).toBe(false);
  });

  it("still excludes the things the image rebuilds for itself", () => {
    expect(isIgnored(contents(), "node_modules/react/index.js")).toBe(true);
    expect(isIgnored(contents(), "apps/web/node_modules/react/index.js")).toBe(true);
  });

  it("does not exclude the source the image is made of", () => {
    for (const path of [
      "apps/api/src/index.ts",
      "apps/api/scripts/cluster-proof.ts",
      "packages/runtime/src/turn-worker.ts",
      "packages/sandbox/src/testing/in-memory-sandbox-manager.ts",
    ]) {
      expect(isIgnored(contents(), path)).toBe(false);
    }
  });
});

describe("reading an ignore file", () => {
  it("reads a bare name as every depth, which is the surprising half", () => {
    expect(isIgnored("docs\n", "apps/web/src/docs/index.ts")).toBe(true);
    expect(isIgnored("/docs\n", "apps/web/src/docs/index.ts")).toBe(false);
    expect(isIgnored("/docs\n", "docs/PLAN.md")).toBe(true);
  });

  it("lets a later negation win, as gitignore does", () => {
    expect(isIgnored("**/.env.*\n!**/.env.example\n", "apps/api/.env.example")).toBe(false);
    expect(isIgnored("!**/.env.example\n**/.env.*\n", "apps/api/.env.example")).toBe(true);
  });

  // The state this file was actually in, and the reason the test above exists.
  it("would have passed .env.local through when only .env was named", () => {
    expect(isIgnored(".env\n**/.env\n", ".env.local")).toBe(false);
  });
});
