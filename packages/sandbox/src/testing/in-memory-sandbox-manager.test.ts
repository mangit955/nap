import { describe, expect, it } from "vitest";
import { describeSandboxManagerConformance } from "./conformance.ts";
import { InMemorySandboxManager } from "./in-memory-sandbox-manager.ts";

/** The commands the conformance suite needs, in the only dialect the fake speaks. */
const STREAMS_OUTPUT = "printf 'one\\n'; printf 'two\\n' >&2";
const FAILS_WITH_CODE_3 = "exit 3";

function scriptedManager(): InMemorySandboxManager {
  const manager = new InMemorySandboxManager();
  manager.script(STREAMS_OUTPUT, { stdout: "one\n", stderr: "two\n" });
  manager.script(FAILS_WITH_CODE_3, { exitCode: 3 });
  return manager;
}

describeSandboxManagerConformance({
  name: "InMemorySandboxManager",
  root: "/home/user",
  commands: { streamsOutput: STREAMS_OUTPUT, failsWithCode3: FAILS_WITH_CODE_3 },
  // Any string is a well-formed id here: the fake validates nothing.
  unknownSandboxId: () => `unknown-${crypto.randomUUID()}`,
  createManager: async () => ({
    manager: scriptedManager(),
    cleanup: async () => {
      // Nothing to release: the whole filesystem is garbage-collected with the instance.
    },
  }),
});

describe("InMemorySandboxManager exec scripting", () => {
  async function sandboxIn(manager: InMemorySandboxManager): Promise<string> {
    const created = await manager.create("project");
    if (!created.ok) throw new Error(created.error.message);
    return created.value.id;
  }

  it("throws on a command no test scripted, naming the command", async () => {
    // Programmer error, not a Result: a test that runs an unscripted command is
    // asserting on a response nobody defined. Returning a bland success would let
    // it pass while exercising nothing.
    const manager = new InMemorySandboxManager();
    const sandboxId = await sandboxIn(manager);

    await expect(manager.exec(sandboxId, "bun install")).rejects.toThrow(/bun install/);
  });

  it("matches a family of commands with a regular expression", async () => {
    const manager = new InMemorySandboxManager();
    const sandboxId = await sandboxIn(manager);
    manager.script(/^git commit/, (command) => ({ stdout: `ran: ${command}` }));

    const result = await manager.exec(sandboxId, "git commit -m 'wip'");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stdout).toBe("ran: git commit -m 'wip'");
  });

  it("prefers an exact match over a regular expression that also matches", async () => {
    const manager = new InMemorySandboxManager();
    const sandboxId = await sandboxIn(manager);
    manager.script(/^git/, { stdout: "generic" });
    manager.script("git rev-parse HEAD", { stdout: "abc123\n" });

    const result = await manager.exec(sandboxId, "git rev-parse HEAD");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stdout).toBe("abc123\n");
  });

  it("lets a later script replace an earlier one for the same command", async () => {
    const manager = new InMemorySandboxManager();
    const sandboxId = await sandboxIn(manager);
    manager.script("git status", { stdout: "dirty" });
    manager.script("git status", { stdout: "clean" });

    const result = await manager.exec(sandboxId, "git status");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.stdout).toBe("clean");
  });

  it("falls back to defaultExec instead of throwing when one is supplied", async () => {
    const manager = new InMemorySandboxManager({
      defaultExec: () => ({ exitCode: 0, stdout: "" }),
    });
    const sandboxId = await sandboxIn(manager);

    const result = await manager.exec(sandboxId, "anything at all");

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.exitCode).toBe(0);
  });

  it("records every command it was asked to run, in order", async () => {
    // Git helpers are specified in terms of which commands they invoke and in what
    // order, so the fake has to be able to answer that.
    const manager = new InMemorySandboxManager({ defaultExec: () => ({}) });
    const sandboxId = await sandboxIn(manager);

    await manager.exec(sandboxId, "git add -A");
    await manager.exec(sandboxId, "git commit -m 'x'");

    expect(manager.commands(sandboxId)).toEqual(["git add -A", "git commit -m 'x'"]);
  });

  it("streams explicit chunks in the order given", async () => {
    const manager = new InMemorySandboxManager();
    const sandboxId = await sandboxIn(manager);
    manager.script("noisy", {
      chunks: [
        { stream: "stdout", data: "a" },
        { stream: "stderr", data: "b" },
        { stream: "stdout", data: "c" },
      ],
    });

    const seen: string[] = [];
    const result = await manager.exec(sandboxId, "noisy", (chunk) => seen.push(chunk.data));

    expect(seen).toEqual(["a", "b", "c"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The aggregate is the concatenation of the chunks, per stream.
    expect(result.value.stdout).toBe("ac");
    expect(result.value.stderr).toBe("b");
  });
});

describe("InMemorySandboxManager preview readiness", () => {
  // The conformance suite cannot cover the success path — it runs against a sandbox with
  // nothing serving — so the fake carries it, and it is what lets downstream tests drive
  // a preview pane through both outcomes without a network.
  it("resolves with the preview URL once a port is marked as serving", async () => {
    const manager = new InMemorySandboxManager();
    const created = await manager.create("project");
    if (!created.ok) throw new Error(created.error.message);
    manager.listen(created.value.id, 5173);

    const ready = await manager.waitForPreview(created.value.id, 5173, { timeoutMs: 50 });
    const url = await manager.getPreviewUrl(created.value.id, 5173);

    expect(ready.ok).toBe(true);
    if (!ready.ok || !url.ok) return;
    // The same address `getPreviewUrl` composes — a caller must not get two answers.
    expect(ready.value).toBe(url.value);
  });

  it("times out on a port nothing is serving", async () => {
    const manager = new InMemorySandboxManager();
    const created = await manager.create("project");
    if (!created.ok) throw new Error(created.error.message);

    const ready = await manager.waitForPreview(created.value.id, 5173, { timeoutMs: 20 });

    expect(ready.ok).toBe(false);
    if (ready.ok) return;
    expect(ready.error.code).toBe("timeout");
  });

  it("distinguishes ports, so one served port does not imply another", async () => {
    const manager = new InMemorySandboxManager();
    const created = await manager.create("project");
    if (!created.ok) throw new Error(created.error.message);
    manager.listen(created.value.id, 5173);

    const other = await manager.waitForPreview(created.value.id, 3000, { timeoutMs: 20 });

    expect(other.ok).toBe(false);
  });
});

describe("InMemorySandboxManager filesystem", () => {
  it("exposes a written file to a resumed handle on the same sandbox", async () => {
    const manager = new InMemorySandboxManager();
    const created = await manager.create("project");
    if (!created.ok) throw new Error(created.error.message);

    await manager.writeFile(created.value.id, "/home/user/app/main.ts", "export {};");
    const resumed = await manager.resume(created.value.id);
    expect(resumed.ok).toBe(true);

    const read = await manager.readFile(created.value.id, "/home/user/app/main.ts");
    expect(read).toEqual({ ok: true, value: "export {};" });
  });

  it("lists an empty directory as empty rather than as an error", async () => {
    const manager = new InMemorySandboxManager();
    const created = await manager.create("project");
    if (!created.ok) throw new Error(created.error.message);

    const listed = await manager.listFiles(created.value.id, "/home/user");

    expect(listed).toEqual({ ok: true, value: [] });
  });

  it("carries the project id on the sandbox it creates", async () => {
    const manager = new InMemorySandboxManager();

    const created = await manager.create("project-42");

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.value.projectId).toBe("project-42");
  });
});
