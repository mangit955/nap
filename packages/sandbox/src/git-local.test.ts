import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ExecResult, SandboxError } from "@nap/shared/ports/sandbox-manager";
import type { Result } from "@nap/shared/result";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bundle, commitAll, restoreBundle, workspaceState } from "./git.ts";
import { decodeRepositoryBundle } from "./git-bundle.ts";
import { InMemorySandboxManager } from "./testing/in-memory-sandbox-manager.ts";
import { localGitEnvironment } from "./testing/local-git-environment.ts";

const exec = promisify(execFile);
let directory: string;
let source: string;
let target: string;

class LocalSandbox extends InMemorySandboxManager {
  /** Every command sent, since each one is a round trip to a real sandbox. */
  readonly issued: string[] = [];

  override async exec(_id: string, command: string): Promise<Result<ExecResult, SandboxError>> {
    this.issued.push(command);
    try {
      const result = await exec("bash", ["-c", transported(command)], {
        env: localGitEnvironment(directory),
      });
      return { ok: true, value: { ...result, exitCode: 0 } };
    } catch (error) {
      return { ok: true, value: { exitCode: 1, stdout: "", stderr: String(error) } };
    }
  }
  override async writeFile(_id: string, path: string, contents: string) {
    await writeFile(transported(path), contents);
    return { ok: true as const, value: undefined };
  }
  override async writeFileBytes(_id: string, path: string, contents: Uint8Array) {
    await writeFile(transported(path), contents);
    return { ok: true as const, value: undefined };
  }
  override async readFileBytes(_id: string, path: string) {
    return { ok: true as const, value: new Uint8Array(await readFile(transported(path))) };
  }
}

/** Where a path the snapshot code writes in the sandbox's `/tmp` lands on this machine instead. */
function transported(path: string): string {
  return path.replaceAll("/tmp/nap-snapshot", join(directory, "transport"));
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

describe("workspaceState", () => {
  async function stateOf(cwd: string) {
    const state = await workspaceState(new LocalSandbox(), "ignored", { cwd });
    if (!state.ok) throw new Error(state.error.message);
    return state.value;
  }

  it("reads the same for a workspace nobody has touched, untracked leftovers included", async () => {
    await writeFile(join(source, "leftover.tsbuildinfo"), "written by a check");

    expect(await stateOf(source)).toBe(await stateOf(source));
  });

  it("changes on an edit nobody has committed yet", async () => {
    const before = await stateOf(source);

    await writeFile(join(source, "file"), "half written");

    expect(await stateOf(source)).not.toBe(before);
  });

  it("changes on a new file", async () => {
    const before = await stateOf(source);

    await writeFile(join(source, "new.ts"), "export {};");

    expect(await stateOf(source)).not.toBe(before);
  });

  it("changes when a commit moves HEAD, even to a clean tree", async () => {
    const before = await stateOf(source);

    await git(source, "commit", "--allow-empty", "-m", "another");

    expect(await stateOf(source)).not.toBe(before);
  });

  it("does not touch the index, which a turn's own git add may be about to lock", async () => {
    // A plain `git status` refreshes the index when a file's stat has moved, and rewriting it is
    // exactly what takes the lock this exists not to take: comparing the file itself is what tells
    // the two apart, because the lock is gone again by the time anything could look for it.
    await writeFile(join(source, "file"), "repository");
    const before = await stat(join(source, ".git", "index"));
    await new Promise((resolve) => setTimeout(resolve, 20));

    await stateOf(source);

    expect((await stat(join(source, ".git", "index"))).mtimeMs).toBe(before.mtimeMs);
  });
});

describe("commitAll", () => {
  // Quotes of both kinds, a newline, and shell syntax that would run if the quoting slipped.
  const MESSAGE = `Add the "login" form, and don't break it\n\nSecond paragraph: $(touch pwned) \`id\``;

  it("commits every change in one command, and reports the commit it made", async () => {
    await writeFile(join(source, "file"), "edited");
    await writeFile(join(source, "new.ts"), "export {};");
    const manager = new LocalSandbox();
    const before = await git(source, "rev-parse", "HEAD");

    const result = await commitAll(manager, "sandbox", MESSAGE, { cwd: source });

    const head = await git(source, "rev-parse", "HEAD");
    expect(head).not.toBe(before);
    // "file" goes from one line to one other line; "new.ts" adds one. Counted by git itself.
    expect(result).toEqual({
      ok: true,
      value: { committed: true, sha: head, diff: { added: 2, removed: 1 } },
    });
    expect(await git(source, "log", "-1", "--format=%B")).toBe(MESSAGE);
    expect(await git(source, "status", "--porcelain")).toBe("");
    expect(manager.issued).toHaveLength(1);
  });

  it("commits a deletion, which only staging everything picks up", async () => {
    await unlink(join(source, "file"));

    const result = await commitAll(new LocalSandbox(), "sandbox", MESSAGE, { cwd: source });

    expect(result).toMatchObject({
      ok: true,
      value: { committed: true, diff: { added: 0, removed: 1 } },
    });
    expect(await git(source, "ls-files")).toBe("");
  });

  it("reports a clean tree as nothing committed, in one command", async () => {
    const manager = new LocalSandbox();
    const before = await git(source, "rev-parse", "HEAD");

    const result = await commitAll(manager, "sandbox", MESSAGE, { cwd: source });

    expect(result).toEqual({ ok: true, value: { committed: false, sha: null, diff: null } });
    expect(await git(source, "rev-parse", "HEAD")).toBe(before);
    expect(manager.issued).toHaveLength(1);
  });

  it("reports a commit git refuses as a failure, never as nothing to commit", async () => {
    // Signing with a program that always fails: staging succeeds and the commit itself does not,
    // which is the step whose failure must not read as a clean tree.
    await git(source, "config", "commit.gpgSign", "true");
    await git(source, "config", "gpg.program", "false");
    await writeFile(join(source, "file"), "edited");
    const before = await git(source, "rev-parse", "HEAD");

    const result = await commitAll(new LocalSandbox(), "sandbox", MESSAGE, { cwd: source });

    expect(result).toMatchObject({ ok: false, error: { code: "exec_failed" } });
    expect(await git(source, "rev-parse", "HEAD")).toBe(before);
  });
});

describe("a snapshot's bytes", () => {
  // Every value a byte can take, so a text channel or an encoding anywhere on the way corrupts it.
  const BINARY = Uint8Array.from({ length: 256 }, (_, index) => index);

  it("round-trip byte for byte, a binary file in the repository included", async () => {
    await writeFile(join(source, "logo.bin"), BINARY);
    await git(source, "add", ".");
    await git(source, "commit", "-m", "Add a binary file");
    const manager = new LocalSandbox();

    const captured = await bundle(manager, "sandbox", { cwd: source });
    if (!captured.ok) throw new Error(captured.error.message);
    // Exactly the file git wrote: nothing re-encoded it between the sandbox and here.
    const decoded = decodeRepositoryBundle(captured.value);
    if (!decoded.ok) throw new Error(decoded.error.message);
    expect(Buffer.from(decoded.value.bundle)).toEqual(
      await readFile(join(directory, "transport.bundle")),
    );

    const restored = await restoreBundle(manager, "sandbox", captured.value, { cwd: target });
    if (!restored.ok) throw new Error(restored.error.message);
    expect(new Uint8Array(await readFile(join(target, "logo.bin")))).toEqual(BINARY);
    expect(await git(target, "rev-parse", "HEAD")).toBe(await git(source, "rev-parse", "HEAD"));
  });

  it("are captured in one command, and travel as bytes rather than through any command's output", async () => {
    const manager = new LocalSandbox();

    const captured = await bundle(manager, "sandbox", { cwd: source });
    if (!captured.ok) throw new Error(captured.error.message);
    expect(manager.issued).toHaveLength(1);
    expect(manager.issued[0]).toContain("git bundle create");

    const restored = await restoreBundle(manager, "sandbox", captured.value, { cwd: target });
    if (!restored.ok) throw new Error(restored.error.message);
    expect(manager.issued.some((command) => command.includes("base64"))).toBe(false);
  });
});
