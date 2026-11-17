/**
 * The guard's shell, run for real: a fake answering by pattern would pass whatever the commands
 * did, and what matters here is that a file a review wrote really comes back as it was.
 */

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import type { ExecResult, SandboxError } from "@nap/shared/ports/sandbox-manager";
import type { Result } from "@nap/shared/result";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { afterReview, beforeReview, type ReviewGuardPaths } from "./task-review-guard.ts";

const exec = promisify(execFile);

class LocalShell extends InMemorySandboxManager {
  override async exec(_id: string, command: string): Promise<Result<ExecResult, SandboxError>> {
    try {
      const { stdout, stderr } = await exec("bash", ["-c", command]);
      return { ok: true, value: { exitCode: 0, stdout, stderr } };
    } catch (error) {
      const failed = error as { code?: number; stdout?: string; stderr?: string };
      return {
        ok: true,
        value: {
          exitCode: failed.code ?? 1,
          stdout: failed.stdout ?? "",
          stderr: failed.stderr ?? "",
        },
      };
    }
  }
}

let directory: string;
let paths: ReviewGuardPaths;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "nap-review-guard-"));
  paths = { root: join(directory, "app"), scratch: join(directory, "scratch") };
  await exec("mkdir", ["-p", paths.root]);
  await writeFile(join(paths.root, "solve.py"), "print(2)\n");
  // Older than the mark by a margin, so a coarse clock cannot make it look written by the review.
  const past = new Date(Date.now() - 60_000);
  await utimes(join(paths.root, "solve.py"), past, past);
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

describe("the review guard", () => {
  it("puts back a file a review changed, removes one it created, and lists both", async () => {
    const shell = new LocalShell();
    const before = await beforeReview(shell, "box", paths);
    expect(before).toEqual({ marked: true, copied: true });

    // What a review's command might do: run the program, which writes its answer, and touch the source.
    await writeFile(join(paths.root, "out.txt"), "2\n");
    await writeFile(join(paths.root, "solve.py"), "print(3)\n");

    const after = await afterReview(shell, "box", before, paths);
    expect(after.restored).toBe(true);
    expect(after.wrote?.sort()).toEqual(["./out.txt", "./solve.py"]);
    expect(await readFile(join(paths.root, "solve.py"), "utf8")).toBe("print(2)\n");
    await expect(stat(join(paths.root, "out.txt"))).rejects.toThrow();
    await expect(stat(paths.scratch)).rejects.toThrow();
  });

  it("lists but cannot put back what a review wrote when nothing was copied", async () => {
    const shell = new LocalShell();
    const before = await beforeReview(shell, "box", paths);
    await writeFile(join(paths.root, "out.txt"), "2\n");

    const after = await afterReview(shell, "box", { ...before, copied: false }, paths);
    expect(after).toEqual({ wrote: ["./out.txt"], restored: false });
    expect(await readFile(join(paths.root, "out.txt"), "utf8")).toBe("2\n");
  });

  it("reports nothing it cannot know when the start was never marked", async () => {
    const shell = new LocalShell();
    expect(await afterReview(shell, "box", { marked: false, copied: false }, paths)).toEqual({
      wrote: null,
      restored: false,
    });
  });

  it("puts a repository's history back whole when a review changed it", async () => {
    const git = (...args: string[]) => exec("git", ["-C", paths.root, ...args]);
    await git("init", "-q", "-b", "main");
    await git("-c", "user.email=a@b", "-c", "user.name=a", "add", ".");
    await git("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qm", "one");
    await writeFile(join(paths.root, "solve.py"), "print(3)\n");
    await git("-c", "user.email=a@b", "-c", "user.name=a", "commit", "-qam", "two");
    const head = (await git("rev-parse", "HEAD")).stdout.trim();
    const past = new Date(Date.now() - 60_000);
    await utimes(join(paths.root, "solve.py"), past, past);
    const shell = new LocalShell();
    const before = await beforeReview(shell, "box", paths);

    // A review's command that moves the repository: the tests would see the older commit.
    await git("checkout", "-q", "HEAD~1");

    const after = await afterReview(shell, "box", before, paths);
    expect(after.restored).toBe(true);
    expect(after.wrote).toContain("./.git");
    expect((await git("rev-parse", "HEAD")).stdout.trim()).toBe(head);
    expect((await git("symbolic-ref", "HEAD")).stdout.trim()).toBe("refs/heads/main");
    expect((await git("status", "--porcelain")).stdout).toBe("");
  });
});
