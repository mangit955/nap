import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { bundle, commitAll, currentSha, restoreBundle, shellQuote } from "./git.ts";
import { TEMPLATE_WORKDIR } from "./template.ts";
import { InMemorySandboxManager } from "./testing/in-memory-sandbox-manager.ts";

const SHA = "9f2c1ab3d4e5f60718293a4b5c6d7e8f90a1b2c3";

/**
 * A manager holding one sandbox, with git scripted to the happy path: staging finds
 * changes, and everything else succeeds quietly.
 */
async function gitSandbox(manager = new InMemorySandboxManager()): Promise<{
  manager: InMemorySandboxManager;
  sandboxId: string;
}> {
  const created = await manager.create("project");
  if (!created.ok) throw new Error(created.error.message);
  return { manager, sandboxId: created.value.id };
}

/** The commands actually issued, with the `cd` prefix stripped so assertions read as git. */
function gitCommands(manager: InMemorySandboxManager, sandboxId: string): string[] {
  return manager.commands(sandboxId).map((c) => c.replace(`cd ${TEMPLATE_WORKDIR} && `, ""));
}

describe("shellQuote", () => {
  // The commit message is written by a model and interpolated into a command line, so
  // this is the boundary between "the agent named a commit" and "the agent ran a command".
  //
  // Asserted against a real shell rather than against an expected string. What matters is
  // not that the output looks a particular way, it is that `sh` parses it back to exactly
  // the input and executes nothing along the way — and only `sh` can settle that. This is
  // still deterministic, offline and instant, so it stays a unit test.
  function throughShell(value: string): string {
    return execFileSync("sh", ["-c", `printf %s ${shellQuote(value)}`], { encoding: "utf8" });
  }

  it("escapes embedded single quotes so the string cannot be closed early", () => {
    // The classic break-out: a bare ' would end the quoted region and leave the rest as
    // shell. The POSIX-portable escape is to close, emit a literal quote, and reopen.
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it.each([
    ["plain text", "Add login form"],
    ["command substitution", "$(touch /tmp/pwned)"],
    ["backticks", "`whoami`"],
    ["a quote-then-command payload", "'; rm -rf /; echo '"],
    ["double quotes", 'say "hello"'],
    ["a newline", "line one\nline two"],
    ["shell metacharacters", "a && b || c | d > e < f & g; h"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell expansion is the input under test.
    ["variable expansion", "$HOME and ${PATH}"],
    ["a backslash", "back\\slash"],
    ["an empty string", ""],
  ])("survives a round trip through sh: %s", (_name, value) => {
    expect(throughShell(value)).toBe(value);
  });

  it("does not execute a substitution payload", () => {
    // Belt and braces on the case that matters most: if the quoting leaked, the shell
    // would run `id` and the output would differ from the literal text.
    expect(throughShell("$(id)")).toBe("$(id)");
  });
});

describe("commitAll", () => {
  it("stages, checks for changes, then commits — in that order", async () => {
    const manager = new InMemorySandboxManager();
    manager.script(/^cd .* && git add -A$/, { exitCode: 0 });
    // Non-zero from `diff --cached --quiet` is git's way of saying "there are changes".
    manager.script(/git diff --cached --quiet$/, { exitCode: 1 });
    manager.script(/git .*commit -m/, { exitCode: 0 });
    manager.script(/git rev-parse HEAD$/, { stdout: `${SHA}\n` });
    const { sandboxId } = await gitSandbox(manager);

    const result = await commitAll(manager, sandboxId, "Add login form");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ committed: true, sha: SHA });

    const commands = gitCommands(manager, sandboxId);
    expect(commands[0]).toBe("git add -A");
    expect(commands[1]).toContain("git diff --cached --quiet");
    expect(commands[2]).toContain("commit -m");
  });

  it("runs commands in the project directory", async () => {
    const manager = new InMemorySandboxManager({ defaultExec: () => ({ exitCode: 1 }) });
    const { sandboxId } = await gitSandbox(manager);

    await commitAll(manager, sandboxId, "msg");

    expect(manager.commands(sandboxId)[0]).toBe(`cd ${TEMPLATE_WORKDIR} && git add -A`);
  });

  it("is a no-op, not an error, when there is nothing to commit", async () => {
    // An agent turn that only reads files must not fail the turn.
    const manager = new InMemorySandboxManager();
    manager.script(/git add -A$/, { exitCode: 0 });
    manager.script(/git diff --cached --quiet$/, { exitCode: 0 });
    const { sandboxId } = await gitSandbox(manager);

    const result = await commitAll(manager, sandboxId, "nothing changed");

    expect(result).toEqual({ ok: true, value: { committed: false, sha: null } });
    // Not merely "reported nothing": no commit was attempted at all.
    expect(gitCommands(manager, sandboxId).some((c) => c.includes("commit"))).toBe(false);
  });

  it("passes a hostile message to git as one literal argument", async () => {
    const manager = new InMemorySandboxManager();
    manager.script(/git add -A$/, { exitCode: 0 });
    manager.script(/git diff --cached --quiet$/, { exitCode: 1 });
    manager.script(/commit -m/, { exitCode: 0 });
    manager.script(/git rev-parse HEAD$/, { stdout: SHA });
    const { sandboxId } = await gitSandbox(manager);

    const hostile = "'; touch /tmp/pwned; echo '";
    await commitAll(manager, sandboxId, hostile);

    const commit = gitCommands(manager, sandboxId).find((c) => c.includes("commit -m"));
    expect(commit).toBeDefined();
    if (commit === undefined) return;

    // Asserting the payload text is absent would be wrong — it *is* present, safely
    // inside quotes. The property that matters is that the message reached the command
    // line quoted, and a real shell recovers it as a single argument. `sh -c` with
    // `printf` stands in for git and prints back whatever the argument actually was.
    expect(commit).toContain(shellQuote(hostile));
    const argument = execFileSync("sh", ["-c", commit.replace(/^git .*commit -m /, "printf %s ")], {
      encoding: "utf8",
    });
    expect(argument).toBe(hostile);
  });

  it("reports a failing git as exec_failed rather than claiming success", async () => {
    const manager = new InMemorySandboxManager();
    manager.script(/git add -A$/, { exitCode: 128, stderr: "fatal: not a git repository" });
    const { sandboxId } = await gitSandbox(manager);

    const result = await commitAll(manager, sandboxId, "msg");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("exec_failed");
    expect(result.error.message).toContain("not a git repository");
  });

  it("propagates a sandbox failure untouched", async () => {
    const manager = new InMemorySandboxManager();
    const { sandboxId } = await gitSandbox(manager);
    await manager.destroy(sandboxId);

    const result = await commitAll(manager, sandboxId, "msg");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // A destroyed sandbox is not a git problem, and mislabelling it would send whoever
    // reads the log looking in the wrong place.
    expect(result.error.code).toBe("destroyed");
  });
});

describe("currentSha", () => {
  it("parses and trims the sha", async () => {
    const manager = new InMemorySandboxManager();
    manager.script(/git rev-parse HEAD$/, { stdout: `${SHA}\n` });
    const { sandboxId } = await gitSandbox(manager);

    expect(await currentSha(manager, sandboxId)).toEqual({ ok: true, value: SHA });
  });

  it("reports a repository with no commits as an error, not an empty sha", async () => {
    const manager = new InMemorySandboxManager();
    manager.script(/git rev-parse HEAD$/, {
      exitCode: 128,
      stderr: "fatal: ambiguous argument 'HEAD'",
    });
    const { sandboxId } = await gitSandbox(manager);

    const result = await currentSha(manager, sandboxId);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("exec_failed");
  });
});

describe("bundle", () => {
  it("creates a bundle of every ref and returns its bytes", async () => {
    const bytes = new Uint8Array([0x50, 0x41, 0x43, 0x4b, 0x00, 0xff]);
    const manager = new InMemorySandboxManager();
    manager.script(/git bundle create/, { stdout: Buffer.from(bytes).toString("base64") });
    const { sandboxId } = await gitSandbox(manager);

    const result = await bundle(manager, sandboxId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(bytes);
    // `--all`, because a snapshot of only the current branch silently loses history.
    expect(gitCommands(manager, sandboxId)[0]).toContain("--all");
  });

  it("tolerates the line wrapping base64 tools add", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const wrapped = `${Buffer.from(bytes).toString("base64")}\n`;
    const manager = new InMemorySandboxManager();
    manager.script(/git bundle create/, { stdout: wrapped });
    const { sandboxId } = await gitSandbox(manager);

    const result = await bundle(manager, sandboxId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(bytes);
  });

  it("reports a failed bundle instead of returning empty bytes", async () => {
    const manager = new InMemorySandboxManager();
    manager.script(/git bundle create/, { exitCode: 128, stderr: "fatal: Refusing to create" });
    const { sandboxId } = await gitSandbox(manager);

    const result = await bundle(manager, sandboxId);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("exec_failed");
  });
});

describe("restoreBundle", () => {
  it("decodes the bundle, then fetches, resets and cleans in order", async () => {
    const manager = new InMemorySandboxManager({ defaultExec: () => ({ exitCode: 0 }) });
    const { sandboxId } = await gitSandbox(manager);

    const result = await restoreBundle(manager, sandboxId, new Uint8Array([9, 8, 7]));

    expect(result.ok).toBe(true);
    const commands = gitCommands(manager, sandboxId);
    expect(commands[0]).toContain("base64 -d");
    expect(commands[1]).toContain("git fetch");
    expect(commands[2]).toContain("git reset --hard FETCH_HEAD");
    expect(commands[3]).toContain("git clean -fd");
  });

  it("writes the payload as base64 rather than raw bytes", async () => {
    // writeFile takes a string, so the bytes have to survive a text channel intact.
    const manager = new InMemorySandboxManager({ defaultExec: () => ({ exitCode: 0 }) });
    const { sandboxId } = await gitSandbox(manager);
    const bytes = new Uint8Array([0, 255, 128]);

    await restoreBundle(manager, sandboxId, bytes);

    const listed = await manager.listFiles(sandboxId, "/tmp");
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const written = listed.value.find((f) => f.path.endsWith(".b64"));
    expect(written).toBeDefined();
    if (written === undefined) return;

    const contents = await manager.readFile(sandboxId, written.path);
    expect(contents.ok).toBe(true);
    if (!contents.ok) return;
    expect(Uint8Array.from(Buffer.from(contents.value, "base64"))).toEqual(bytes);
  });

  it("never passes -x to git clean, so ignored files survive", async () => {
    // node_modules is gitignored and baked into the image. `git clean -fdx` would delete
    // it and turn a one-second project open into a full reinstall.
    const manager = new InMemorySandboxManager({ defaultExec: () => ({ exitCode: 0 }) });
    const { sandboxId } = await gitSandbox(manager);

    await restoreBundle(manager, sandboxId, new Uint8Array([1]));

    const clean = gitCommands(manager, sandboxId).find((c) => c.includes("git clean"));
    expect(clean).toBeDefined();
    expect(clean).not.toContain("-x");
  });

  it("reports a corrupt bundle as exec_failed", async () => {
    const manager = new InMemorySandboxManager();
    manager.script(/base64 -d/, { exitCode: 0 });
    manager.script(/git fetch/, { exitCode: 128, stderr: "fatal: not a bundle" });
    const { sandboxId } = await gitSandbox(manager);

    const result = await restoreBundle(manager, sandboxId, new Uint8Array([1, 2]));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("exec_failed");
    expect(result.error.message).toContain("not a bundle");
  });
});
