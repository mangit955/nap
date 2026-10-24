import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { APP_TEST_TASKS } from "@nap/bench/app-test";
import { expect, it, vi } from "vitest";
import { prepareAppTestFixture } from "./app-test-fixture.ts";

it("prepares reproducible real commits, source diffs and syntax checks for every variant", () => {
  for (const task of APP_TEST_TASKS) {
    const a = prepareAppTestFixture(task);
    const b = prepareAppTestFixture(task);
    try {
      expect(a.directory).not.toBe(b.directory);
      expect(a.commitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(a.commitSha).toBe(b.commitSha);
      expect(a.baseSha).not.toBe(a.commitSha);
      expect(a.diff).toContain("diff --git a/src/app.js b/src/app.js");
      expect(a.diff).not.toMatch(/buggy|correct|planted/i);
      expect(a.checks).toEqual([{ name: "fixture-syntax", outcome: "passed", output: null }]);
      expect(a.git(["status", "--porcelain"])).toBe("");
      a.verify();
      writeFileSync(join(a.directory, "src/app.js"), "invalid syntax {{{");
      expect(() => a.verify()).toThrow();
      writeFileSync(join(a.directory, "src/app.js"), `${a.files["src/app.js"]}\n// changed\n`);
      expect(() => a.verify()).toThrow("Fixture source changed after checkpoint");
    } finally {
      a.dispose();
      b.dispose();
    }
    expect(existsSync(a.directory)).toBe(false);
  }
}, 20_000);

it("isolates fixture git commands from caller and hook git-routing variables", () => {
  vi.stubEnv("GIT_DIR", "/napbench-nonexistent/git-dir");
  vi.stubEnv("GIT_WORK_TREE", "/napbench-nonexistent/work-tree");
  vi.stubEnv("GIT_INDEX_FILE", "/napbench-nonexistent/index");
  try {
    const fixture = prepareAppTestFixture(APP_TEST_TASKS[0]!);
    try {
      expect(fixture.git(["rev-parse", "HEAD"]).trim()).toBe(fixture.commitSha);
      fixture.git(["commit", "--quiet", "--allow-empty", "-m", "Changed HEAD"]);
      expect(() => fixture.verify()).toThrow("Fixture source changed after checkpoint");
    } finally {
      fixture.dispose();
    }
  } finally {
    vi.unstubAllEnvs();
  }
});
