import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitComparisonSchema, type GitScope } from "@nap/shared/git-protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMPARISON_SCRIPT, compareGit } from "./git-comparison.ts";
import { InMemorySandboxManager } from "./testing/in-memory-sandbox-manager.ts";
import { localGitEnvironment } from "./testing/local-git-environment.ts";

let cwd: string;
const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd,
    env: localGitEnvironment(cwd),
    encoding: "utf8",
    timeout: 5000,
  });
const commit = () => {
  git("add", "-A");
  git("-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "Checkpoint");
};
function compare(scope: GitScope, base = "") {
  return GitComparisonSchema.parse(
    JSON.parse(
      execFileSync(process.execPath, ["-e", COMPARISON_SCRIPT, "--", scope, base], {
        cwd,
        env: localGitEnvironment(cwd),
        encoding: "utf8",
        timeout: 25_000,
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
    const indexPath = join(cwd, git("rev-parse", "--git-path", "index").trim());
    const index = readFileSync(indexPath);
    const indexMetadata = () => {
      const { dev, ino, mode, size, mtimeNs, ctimeNs } = statSync(indexPath, { bigint: true });
      return { dev, ino, mode, size, mtimeNs, ctimeNs };
    };
    const metadata = indexMetadata();
    expect(compare("branch", "main").files).toHaveLength(0);
    expect(readFileSync(indexPath)).toEqual(index);
    expect(indexMetadata()).toEqual(metadata);
  });
  it.each(["uncommitted", "branch"] satisfies GitScope[])(
    "%s omits an unchanged file recreated after staging its deletion and preserves the index",
    (scope) => {
      git("rm", "app.ts");
      writeFileSync(join(cwd, "app.ts"), "old\nkeep\n");
      const indexPath = join(cwd, git("rev-parse", "--git-path", "index").trim());
      const index = readFileSync(indexPath);
      const staged = git("diff", "--cached", "--binary");
      const result = compare(scope, scope === "branch" ? "main" : "");
      expect.soft(result.files).toEqual([]);
      expect(readFileSync(indexPath)).toEqual(index);
      expect(git("diff", "--cached", "--binary")).toBe(staged);
      expect(readFileSync(join(cwd, "app.ts"), "utf8")).toBe("old\nkeep\n");
    },
  );
  it.each(["uncommitted", "branch"] satisfies GitScope[])(
    "%s folds deletion and edited recreation into one net modification without touching the index",
    (scope) => {
      git("rm", "--cached", "app.ts");
      writeFileSync(join(cwd, "app.ts"), "final\nkeep\n");
      const indexPath = join(cwd, git("rev-parse", "--git-path", "index").trim());
      const index = readFileSync(indexPath);
      const result = compare(scope, scope === "branch" ? "main" : "");
      expect.soft(result.files).toHaveLength(1);
      expect.soft(new Set(result.files.map((file) => file.path)).size).toBe(result.files.length);
      expect.soft(result.files[0]).toMatchObject({
        path: "app.ts",
        status: "modified",
        additions: 1,
        deletions: 1,
        previousPath: null,
      });
      expect.soft(result.files[0]?.patch).toContain("-old\n+final");
      expect(readFileSync(indexPath)).toEqual(index);
      expect(readFileSync(join(cwd, "app.ts"), "utf8")).toBe("final\nkeep\n");
      expect(compare("commit").files.find((file) => file.path === "app.ts")?.patch).not.toContain(
        "+final",
      );
    },
  );
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

describe("comparison consistency and safe errors", () => {
  it.each(["contents", "inventory", "index"])(
    "rejects a concurrent %s change with an unchanged HEAD",
    async (change) => {
      writeFileSync(join(cwd, "app.ts"), "first edit\nkeep\n");
      const injection = `
        const childProcess = require('node:child_process');
        const originalExec = childProcess.execFileSync;
        let changed = false;
        childProcess.execFileSync = (command, args, options) => {
          const output = originalExec(command, args, options);
          if (!changed && args.includes('diff') && !args.includes('--name-status')) {
            changed = true;
            const fs = require('node:fs');
            if (${JSON.stringify(change)} === 'contents') fs.writeFileSync('app.ts', 'second edit of different size\\nkeep\\n');
            if (${JSON.stringify(change)} === 'inventory') fs.writeFileSync('arrived.ts', 'new\\n');
            if (${JSON.stringify(change)} === 'index') originalExec('git', ['add', 'app.ts'], { timeout: 5000 });
          }
          return output;
        };
      `;
      const result = spawnSync(
        process.execPath,
        ["-e", injection + COMPARISON_SCRIPT, "--", "uncommitted", ""],
        { cwd, env: localGitEnvironment(cwd), encoding: "utf8", timeout: 25_000 },
      );
      expect.soft(result.status).toBe(1);
      const manager = new InMemorySandboxManager({
        defaultExec: () => ({
          exitCode: result.status ?? 1,
          stdout: result.stdout,
          stderr: result.stderr,
        }),
      });
      const sandbox = await manager.create("consistency");
      if (!sandbox.ok) throw new Error("fixture sandbox unavailable");
      const comparison = await compareGit(manager, sandbox.value.id, { scope: "uncommitted" });
      expect(comparison.ok).toBe(false);
      if (!comparison.ok) {
        expect(comparison.error.message).toMatch(/changed.*refresh/i);
        expect(comparison.error.message).not.toMatch(/base branch/i);
      }
    },
  );
  it.each([
    ["ETIMEDOUT", /time|deadline/i],
    ["ENOBUFS", /output|large|limit/i],
  ] as const)("reports a safe %s failure instead of invalid-base advice", async (code, message) => {
    const injection = `require('node:child_process').execFileSync = () => { throw Object.assign(new Error('PRIVATE upstream detail'), { code: ${JSON.stringify(code)} }); };`;
    const result = spawnSync(
      process.execPath,
      ["-e", injection + COMPARISON_SCRIPT, "--", "commit", ""],
      { cwd, env: localGitEnvironment(cwd), encoding: "utf8", timeout: 25_000 },
    );
    const manager = new InMemorySandboxManager({
      defaultExec: () => ({
        exitCode: result.status ?? 1,
        stdout: result.stdout,
        stderr: result.stderr,
      }),
    });
    const sandbox = await manager.create("errors");
    if (!sandbox.ok) throw new Error("fixture sandbox unavailable");
    const comparison = await compareGit(manager, sandbox.value.id, { scope: "commit" });
    expect(comparison.ok).toBe(false);
    if (!comparison.ok) {
      expect(comparison.error.message).toMatch(message);
      expect(comparison.error.message).not.toMatch(/PRIVATE|base branch/);
    }
  });
  it("keeps collision patch paths canonical, including shell metacharacters", () => {
    const path = "odd ' $(path).ts";
    writeFileSync(join(cwd, path), "before\n");
    commit();
    git("rm", "--cached", "--", path);
    writeFileSync(join(cwd, path), "after\n");
    const result = compare("uncommitted");
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({ path, status: "modified", additions: 1, deletions: 1 });
    expect(result.files[0]?.patch).toContain(`diff --git a/${path} b/${path}`);
    expect(result.files[0]?.patch).not.toMatch(/nap-compare|\/tmp\//);
  });
  it("retains binary detection when reconciling a recreated file", () => {
    writeFileSync(join(cwd, "image.bin"), Buffer.from([0, 1, 2]));
    commit();
    git("rm", "--cached", "image.bin");
    writeFileSync(join(cwd, "image.bin"), Buffer.from([0, 3, 4]));
    const result = compare("uncommitted");
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({ path: "image.bin", status: "modified", binary: true });
    expect(result.files[0]?.patch).toContain("Binary files a/image.bin and b/image.bin differ");
  });
  it("retains a recreated file's symlink type instead of reading its target", () => {
    git("rm", "app.ts");
    symlinkSync("deleted.txt", join(cwd, "app.ts"));
    const result = compare("uncommitted");
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toMatchObject({ path: "app.ts", status: "typechanged" });
    expect(result.files[0]?.patch).toContain("120000");
    expect(result.files[0]?.patch).toContain("+deleted.txt");
  });
});
