import { execFileSync } from "node:child_process";
import { shellQuote } from "@nap/shared/shell";
import { describe, expect, it } from "vitest";
import { BUNDLE_PATH, bundle, commitAll, commitScript, currentSha, restoreBundle } from "./git.ts";
import { decodeRepositoryBundle } from "./git-bundle.ts";
import { TEMPLATE_WORKDIR } from "./template.ts";
import { InMemorySandboxManager } from "./testing/in-memory-sandbox-manager.ts";
import {
  BUNDLE_COMMAND,
  bundled,
  COMMIT_COMMAND,
  committed,
  NOTHING_COMMITTED,
} from "./testing/script-git.ts";

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

    expect(result).toEqual({
      ok: true,
      value: { committed: true, sha: SHA, diff: { added: 3, removed: 1 } },
    });
    const commands = gitCommands(manager, sandboxId);
    expect(commands).toHaveLength(1);
    const [script = ""] = commands;
    const steps = [
      "git add --all",
      "git diff --quiet --cached",
      "commit --message=",
      "show --shortstat",
      "rev-parse",
    ];
    const positions = steps.map((step) => script.indexOf(step));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("reads the commit's line counts from git's own summary, and says nothing it was not told", async () => {
    const cases: [string, { added: number; removed: number } | null][] = [
      [" 2 files changed, 412 insertions(+), 88 deletions(-)", { added: 412, removed: 88 }],
      [" 1 file changed, 1 insertion(+)", { added: 1, removed: 0 }],
      [" 1 file changed, 1 deletion(-)", { added: 0, removed: 1 }],
      // A binary file or a mode change: a commit, but no lines either way.
      [" 1 file changed", { added: 0, removed: 0 }],
      // No summary at all is unknown, not zero: a card showing +0 −0 would be a wrong fact.
      ["", null],
    ];
    for (const [summary, diff] of cases) {
      const manager = new InMemorySandboxManager().script(COMMIT_COMMAND, {
        exitCode: 0,
        stdout: `[main 9e107d9] Nap turn\n${summary}\n${SHA}\n`,
      });
      const { sandboxId } = await gitSandbox(manager);
      const result = await commitAll(manager, sandboxId, "msg");
      expect(result).toEqual({ ok: true, value: { committed: true, sha: SHA, diff } });
    }
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

    expect(result).toEqual({ ok: true, value: { committed: false, sha: null, diff: null } });
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
      ["-c", `printf %s ${quoted.slice(0, quoted.indexOf(" && git show"))}`],
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
  it("writes a bundle of every ref in one command, and returns the bytes it wrote", async () => {
    const bytes = new Uint8Array([0x50, 0x41, 0x43, 0x4b, 0x00, 0xff]);
    const manager = new InMemorySandboxManager();
    manager.script(BUNDLE_COMMAND, bundled("refs/heads/main", bytes));
    const { sandboxId } = await gitSandbox(manager);

    const result = await bundle(manager, sandboxId);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(decodeRepositoryBundle(result.value)).toEqual({
      ok: true,
      value: { bundle: Buffer.from(bytes), head: "refs/heads/main" },
    });
    const commands = gitCommands(manager, sandboxId);
    expect(commands).toHaveLength(1);
    // `--all`, because a snapshot of only the current branch silently loses history.
    expect(commands[0]).toContain("--all");
    // Read back as a file. Through the command's output it was base64: a third larger, every turn.
    expect(commands[0]).not.toContain("base64");
  });

  it("reports a failed bundle instead of returning empty bytes", async () => {
    const manager = new InMemorySandboxManager();
    manager.script(BUNDLE_COMMAND, { exitCode: 128, stderr: "fatal: Refusing to create" });
    const { sandboxId } = await gitSandbox(manager);

    const result = await bundle(manager, sandboxId);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("exec_failed");
  });

  it("reports a bundle the command did not leave behind, rather than an empty snapshot", async () => {
    const manager = new InMemorySandboxManager();
    manager.script(BUNDLE_COMMAND, { stdout: "refs/heads/main\n" });
    const { sandboxId } = await gitSandbox(manager);

    const result = await bundle(manager, sandboxId);

    expect(result).toMatchObject({ ok: false, error: { code: "file_not_found" } });
  });
});

describe("restoreBundle", () => {
  it("restores in one round trip after the upload: verify, clone, swap, reset, clean, in order", async () => {
    // Every command is a round trip to the sandbox, and a reopened project waits for all of them.
    const manager = new InMemorySandboxManager({ defaultExec: () => ({ exitCode: 0 }) });
    const { sandboxId } = await gitSandbox(manager);

    const result = await restoreBundle(manager, sandboxId, new Uint8Array([9, 8, 7]));

    expect(result).toEqual({ ok: true, value: { probe: null } });
    const commands = gitCommands(manager, sandboxId);
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatch(
      /git bundle verify[\s\S]*clone --mirror[\s\S]*rm -rf \.git[\s\S]*git reset --hard HEAD[\s\S]*git clean -fd/,
    );
  });

  it("joins every step with &&, so a failing one stops the steps after it", async () => {
    const manager = new InMemorySandboxManager({ defaultExec: () => ({ exitCode: 0 }) });
    const { sandboxId } = await gitSandbox(manager);

    await restoreBundle(manager, sandboxId, new Uint8Array([9]));

    // A `;` anywhere would let `rm -rf .git` run after a failed verify, and destroy the template's
    // repository on the strength of a bundle git had refused.
    expect(gitCommands(manager, sandboxId)[0]).not.toContain(";");
  });

  it("writes the payload as the bytes themselves, with nothing to decode in the sandbox", async () => {
    const manager = new InMemorySandboxManager({ defaultExec: () => ({ exitCode: 0 }) });
    const { sandboxId } = await gitSandbox(manager);
    const bytes = new Uint8Array([0, 255, 128]);

    await restoreBundle(manager, sandboxId, bytes);

    expect(await manager.readFileBytes(sandboxId, BUNDLE_PATH)).toEqual({ ok: true, value: bytes });
    expect(gitCommands(manager, sandboxId).some((command) => command.includes("base64"))).toBe(
      false,
    );
  });

  it("never passes -x to git clean, so ignored files survive", async () => {
    // node_modules is gitignored and baked into the image. `git clean -fdx` would delete
    // it and turn a one-second project open into a full reinstall.
    const manager = new InMemorySandboxManager({ defaultExec: () => ({ exitCode: 0 }) });
    const { sandboxId } = await gitSandbox(manager);

    await restoreBundle(manager, sandboxId, new Uint8Array([1]));

    const clean = gitCommands(manager, sandboxId)[0]?.match(/git clean[^&]*/)?.[0];
    expect(clean).toBe("git clean -fd");
  });

  it("runs a probe on the old tree and the new one, in the same round trip, and hands back both", async () => {
    const manager = new InMemorySandboxManager();
    manager.script(/git bundle verify/, { exitCode: 0, stdout: "before-line\nafter-line\n" });
    const { sandboxId } = await gitSandbox(manager);

    const result = await restoreBundle(manager, sandboxId, new Uint8Array([1]), {
      probe: "echo probed",
    });

    expect(result).toEqual({
      ok: true,
      value: { probe: { before: "before-line", after: "after-line" } },
    });
    const [command] = gitCommands(manager, sandboxId);
    expect(command?.indexOf("$(echo probed)")).toBeLessThan(
      command?.indexOf("git bundle verify") ?? -1,
    );
    expect(command?.lastIndexOf("$(echo probed)")).toBeGreaterThan(
      command?.indexOf("git clean") ?? Number.POSITIVE_INFINITY,
    );
  });

  it("hands back empty probe lines rather than inventing them when nothing was printed", async () => {
    const manager = new InMemorySandboxManager();
    manager.script(/git bundle verify/, { exitCode: 0 });
    const { sandboxId } = await gitSandbox(manager);

    const result = await restoreBundle(manager, sandboxId, new Uint8Array([1]), { probe: "true" });

    expect(result).toEqual({ ok: true, value: { probe: { before: "", after: "" } } });
  });

  it("reports a corrupt bundle as exec_failed", async () => {
    const manager = new InMemorySandboxManager();
    manager.script(/git bundle verify/, { exitCode: 128, stderr: "fatal: not a bundle" });
    const { sandboxId } = await gitSandbox(manager);

    const result = await restoreBundle(manager, sandboxId, new Uint8Array([1, 2]));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("exec_failed");
    expect(result.error.message).toContain("not a bundle");
  });
});
