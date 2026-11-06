import { execFileSync } from "node:child_process";
import { shellQuote } from "@nap/shared/shell";
import { describe, expect, it } from "vitest";
import { bundle, commitAll, commitScript, currentSha, restoreBundle } from "./git.ts";
import { decodeRepositoryBundle } from "./git-bundle.ts";
import { TEMPLATE_WORKDIR } from "./template.ts";
import { InMemorySandboxManager } from "./testing/in-memory-sandbox-manager.ts";
import { COMMIT_COMMAND, committed, NOTHING_COMMITTED } from "./testing/script-git.ts";

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

describe("commitAll", () => {
  it("stages, checks for changes, commits and reads the sha — in that order, in one command", async () => {
    // One command, because each one is a round trip to the sandbox and a turn waits for all of them.
    const manager = new InMemorySandboxManager();
    manager.script(COMMIT_COMMAND, committed(SHA));
    const { sandboxId } = await gitSandbox(manager);

    const result = await commitAll(manager, sandboxId, "Add login form");

    expect(result).toEqual({ ok: true, value: { committed: true, sha: SHA } });
    const commands = gitCommands(manager, sandboxId);
    expect(commands).toHaveLength(1);
    const [script = ""] = commands;
    const steps = ["git add --all", "git diff --quiet --cached", "commit --message=", "rev-parse"];
    const positions = steps.map((step) => script.indexOf(step));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("runs in the project directory", async () => {
    const manager = new InMemorySandboxManager().script(COMMIT_COMMAND, NOTHING_COMMITTED);
    const { sandboxId } = await gitSandbox(manager);

    await commitAll(manager, sandboxId, "msg");

    expect(manager.commands(sandboxId)[0]).toBe(`cd ${TEMPLATE_WORKDIR} && ${commitScript("msg")}`);
  });

  it("is a no-op, not an error, when there is nothing to commit", async () => {
    // An agent turn that only reads files must not fail the turn.
    const manager = new InMemorySandboxManager().script(COMMIT_COMMAND, NOTHING_COMMITTED);
    const { sandboxId } = await gitSandbox(manager);

    const result = await commitAll(manager, sandboxId, "nothing changed");

    expect(result).toEqual({ ok: true, value: { committed: false, sha: null } });
  });

  it("passes a hostile message to git as one literal argument", async () => {
    const hostile = "'; touch /tmp/pwned; echo '\nand a $(second) `line`";
    const script = commitScript(hostile);

    // Asserting the payload text is absent would be wrong — it *is* present, safely inside
    // quotes. The property that matters is that a real shell recovers it as a single argument:
    // `sh -c` with `printf` stands in for git and prints back whatever the argument was.
    expect(script).toContain(`--message=${shellQuote(hostile)}`);
    const quoted = script.slice(script.indexOf("--message=") + "--message=".length);
    const argument = execFileSync(
      "sh",
      ["-c", `printf %s ${quoted.slice(0, quoted.indexOf(" && git rev-parse"))}`],
      { encoding: "utf8" },
    );
    expect(argument).toBe(hostile);
  });

  it("reports a failing git as exec_failed rather than claiming success", async () => {
    const manager = new InMemorySandboxManager().script(COMMIT_COMMAND, {
      exitCode: 128,
      stderr: "fatal: not a git repository",
    });
    const { sandboxId } = await gitSandbox(manager);

    const result = await commitAll(manager, sandboxId, "msg");

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("exec_failed");
    expect(result.error.message).toContain("not a git repository");
  });

  it("refuses output it cannot read as either outcome, rather than guessing", async () => {
    // A script that exited 0 but printed neither the marker nor a sha has not said what it did,
    // and reading that as "nothing to commit" would report a lost commit as a quiet turn.
    const manager = new InMemorySandboxManager().script(COMMIT_COMMAND, { stdout: "" });
    const { sandboxId } = await gitSandbox(manager);

    const result = await commitAll(manager, sandboxId, "msg");

    expect(result).toMatchObject({ ok: false, error: { code: "exec_failed" } });
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
    manager.script(/git symbolic-ref/, { stdout: "refs/heads/main" });
    manager.script(/git bundle create/, { stdout: Buffer.from(bytes).toString("base64") });
    const { sandboxId } = await gitSandbox(manager);

    const result = await bundle(manager, sandboxId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(decodeRepositoryBundle(result.value)).toEqual({
      ok: true,
      value: { bundle: Buffer.from(bytes), head: "refs/heads/main" },
    });
    // `--all`, because a snapshot of only the current branch silently loses history.
    expect(gitCommands(manager, sandboxId)[1]).toContain("--all");
  });

  it("tolerates the line wrapping base64 tools add", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const wrapped = `${Buffer.from(bytes).toString("base64")}\n`;
    const manager = new InMemorySandboxManager();
    manager.script(/git symbolic-ref/, { stdout: "refs/heads/main" });
    manager.script(/git bundle create/, { stdout: wrapped });
    const { sandboxId } = await gitSandbox(manager);

    const result = await bundle(manager, sandboxId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(decodeRepositoryBundle(result.value)).toEqual({
      ok: true,
      value: { bundle: Buffer.from(bytes), head: "refs/heads/main" },
    });
  });

  it("reports a failed bundle instead of returning empty bytes", async () => {
    const manager = new InMemorySandboxManager();
    manager.script(/git symbolic-ref/, { stdout: "refs/heads/main" });
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
    expect(commands[1]).toContain("clone --mirror");
    expect(commands[3]).toContain("git reset --hard HEAD");
    expect(commands[4]).toContain("git clean -fd");
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
    manager.script(/git bundle verify/, { exitCode: 128, stderr: "fatal: not a bundle" });
    const { sandboxId } = await gitSandbox(manager);

    const result = await restoreBundle(manager, sandboxId, new Uint8Array([1, 2]));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("exec_failed");
    expect(result.error.message).toContain("not a bundle");
  });
});
