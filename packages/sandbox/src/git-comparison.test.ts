import { execFileSync } from "node:child_process";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitComparisonSchema, type GitScope } from "@nap/shared/git-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMPARISON_SCRIPT } from "./git-comparison.ts";

let cwd: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" });
const commit = () => {
  git("add", "-A");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "Checkpoint");
};
function compare(scope: GitScope, base = "") {
  return GitComparisonSchema.parse(
    JSON.parse(
      execFileSync(process.execPath, ["-e", COMPARISON_SCRIPT, "--", scope, base], {
        cwd,
        encoding: "utf8",
        maxBuffer: 2 * 1024 * 1024,
      }),
    ),
  );
}
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "nap-compare-"));
  git("init", "-q", "-b", "main");
  writeFileSync(join(cwd, "app.ts"), "old\nkeep\n");
  writeFileSync(join(cwd, "deleted.txt"), "remove\n");
  commit();
});
afterEach(() => rmSync(cwd, { recursive: true, force: true }));

describe("repository comparisons against real Git", () => {
  it("compares the first commit with an empty tree", () => {
    expect(compare("commit").files.map((file) => file.status)).toEqual(["added", "added"]);
  });
  it("shows net edits, staged changes, deletions and untracked files without changing the index", () => {
    writeFileSync(join(cwd, "app.ts"), "intermediate\nkeep\n");
    git("add", "app.ts");
    writeFileSync(join(cwd, "app.ts"), "final\nkeep\n");
    rmSync(join(cwd, "deleted.txt"));
    writeFileSync(join(cwd, "new ' $(file).ts"), "new\n");
    const index = git("diff", "--cached");
    const result = compare("uncommitted");
    expect(result.files.find((file) => file.path === "app.ts")).toMatchObject({
      additions: 1,
      deletions: 1,
      status: "modified",
    });
    expect(result.files.find((file) => file.path === "app.ts")?.patch).toContain("+final");
    expect(result.files.find((file) => file.path === "deleted.txt")?.status).toBe("deleted");
    expect(result.files.find((file) => file.path === "new ' $(file).ts")?.status).toBe("untracked");
    expect(git("diff", "--cached")).toBe(index);
  });
  it("keeps committed branch work visible after automatic commits", () => {
    git("checkout", "-qb", "task");
    writeFileSync(join(cwd, "app.ts"), "changed\nkeep\n");
    commit();
    expect(compare("uncommitted").files).toHaveLength(0);
    expect(compare("branch", "main").files).toHaveLength(1);
    expect(compare("commit").files).toHaveLength(1);
    writeFileSync(join(cwd, "app.ts"), "old\nkeep\n");
    expect(compare("branch", "main").files).toHaveLength(0);
  });
  it("reports renames and binary files and changes revision after edits", () => {
    renameSync(join(cwd, "app.ts"), join(cwd, "renamed.ts"));
    git("add", "-A");
    writeFileSync(join(cwd, "image.bin"), Buffer.from([0, 1, 2, 3]));
    const first = compare("branch");
    expect(first.files.find((file) => file.path === "renamed.ts")).toMatchObject({
      status: "renamed",
      previousPath: "app.ts",
    });
    expect(first.files.find((file) => file.path === "image.bin")?.binary).toBe(true);
    writeFileSync(join(cwd, "renamed.ts"), "changed\n");
    expect(compare("branch").revision).not.toBe(first.revision);
  });
  it("caps oversized patches and explicitly marks truncation", () => {
    writeFileSync(join(cwd, "large.txt"), "hello world\n".repeat(20000));
    const result = compare("branch");
    expect(result.truncated).toBe(true);
    expect(result.files[0]?.truncated).toBe(true);
    expect(Buffer.byteLength(result.files[0]?.patch ?? "")).toBeLessThanOrEqual(120 * 1024);
  });
});
