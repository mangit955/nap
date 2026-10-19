import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExecResult, SandboxError } from "@nap/shared/ports/sandbox-manager";
import type { Result } from "@nap/shared/result";
import { afterEach, beforeEach, expect, it } from "vitest";
import { bundle, restoreBundle } from "./git.ts";
import { InMemorySandboxManager } from "./testing/in-memory-sandbox-manager.ts";
import { localGitEnvironment } from "./testing/local-git-environment.ts";

const exec = promisify(execFile);
let directory: string;
let source: string;
let target: string;

class LocalSandbox extends InMemorySandboxManager {
  override async exec(_id: string, command: string): Promise<Result<ExecResult, SandboxError>> {
    try {
      const result = await exec(
        "bash",
        ["-c", command.replaceAll("/tmp/nap-snapshot", join(directory, "transport"))],
        { env: localGitEnvironment(directory) },
      );
      return { ok: true, value: { ...result, exitCode: 0 } };
    } catch (error) {
      return { ok: true, value: { exitCode: 1, stdout: "", stderr: String(error) } };
    }
  }
  override async writeFile(_id: string, path: string, contents: string) {
    await writeFile(path.replaceAll("/tmp/nap-snapshot", join(directory, "transport")), contents);
    return { ok: true as const, value: undefined };
  }
}

async function git(cwd: string, ...args: string[]) {
  const result = await exec("git", args, { cwd, env: localGitEnvironment(directory) });
  return result.stdout.trim();
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "nap-git-"));
  source = join(directory, "source");
  target = join(directory, "target");
  for (const cwd of [source, target]) {
    await mkdir(cwd);
    await git(cwd, "init", "-b", "main");
    await writeFile(join(cwd, "file"), cwd === source ? "repository" : "template");
    await git(cwd, "add", ".");
    await git(cwd, "commit", "-m", "Initial");
  }
});

afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

it("restores every ref and the exact branch even when two branches point to one commit", async () => {
  await git(source, "checkout", "-b", "nap/job-one");
  await git(source, "tag", "v1");
  const manager = new LocalSandbox();
  const captured = await bundle(manager, "sandbox", { cwd: source });
  expect(captured.ok).toBe(true);
  if (!captured.ok) return;
  const restored = await restoreBundle(manager, "sandbox", captured.value, { cwd: target });
  if (!restored.ok) throw new Error(restored.error.message);
  expect(await git(target, "symbolic-ref", "HEAD")).toBe("refs/heads/nap/job-one");
  expect(await git(target, "for-each-ref", "--format=%(refname):%(objectname)")).toBe(
    await git(source, "for-each-ref", "--format=%(refname):%(objectname)"),
  );
  expect(await readFile(join(target, "file"), "utf8")).toBe("repository");
});

it("preserves detached HEAD and commits reachable only from HEAD", async () => {
  await git(source, "checkout", "--detach");
  await writeFile(join(source, "file"), "detached");
  await git(source, "commit", "-am", "Detached commit");
  const manager = new LocalSandbox();
  const captured = await bundle(manager, "sandbox", { cwd: source });
  if (!captured.ok) throw new Error(captured.error.message);
  const restored = await restoreBundle(manager, "sandbox", captured.value, { cwd: target });
  if (!restored.ok) throw new Error(restored.error.message);
  expect(await git(target, "rev-parse", "HEAD")).toBe(await git(source, "rev-parse", "HEAD"));
  expect(await git(target, "branch", "--show-current")).toBe("");
});

it("rejects an invalid bundle without changing the live repository", async () => {
  const before = await git(target, "rev-parse", "HEAD");
  const result = await restoreBundle(new LocalSandbox(), "sandbox", Buffer.from("not a bundle"), {
    cwd: target,
  });
  expect(result.ok).toBe(false);
  expect(await git(target, "rev-parse", "HEAD")).toBe(before);
  expect(await readFile(join(target, "file"), "utf8")).toBe("template");
});
