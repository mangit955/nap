import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import type { PendingEvent } from "@nap/shared/ports/event-store";
import type { LLMToolCall } from "@nap/shared/ports/llm-provider";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalShellSandbox } from "../testing/local-shell-sandbox.ts";
import type { ToolContext } from "./context.ts";
import { PROJECT_ROOT } from "./definitions.ts";
import { executeTool } from "./execute.ts";

/**
 * Background shells, against a real `bash` in a temporary directory.
 *
 * A scripted sandbox would prove only that these tools send the commands they were written to
 * send. The properties worth having — that a shell outlives the call that started it, that its
 * output is read once and in order, that typing reaches a waiting process and stopping one
 * stops what it started — hold or fail inside a shell, so that is where they are tested.
 */

let sandbox: LocalShellSandbox;
let events: PendingEvent[];

beforeEach(async () => {
  sandbox = await LocalShellSandbox.create();
  events = [];
});

afterEach(async () => {
  await sandbox.dispose();
});

function context(): ToolContext {
  return {
    sessionId: "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77",
    turnId: "7c9b1a52-8d3e-4f21-a0c4-1b2d3e4f5a6b",
    sandboxId: sandbox.id,
    sandbox,
    emit: (event) => events.push(event as PendingEvent),
    now: () => "2026-01-01T00:00:00.000Z",
  };
}

let ids = 0;
function call(name: string, input: Record<string, unknown>): LLMToolCall {
  ids += 1;
  return { id: `toolu_${ids}`, name, input };
}

async function run(name: string, input: Record<string, unknown>) {
  return executeTool(call(name, input), context());
}

/** Starts a command, returning its id and what the start already read of it. */
async function begin(command: string): Promise<{ id: string; output: string }> {
  const started = await run("run_command", { command, background: true });
  expect(started.ok).toBe(true);
  const id = /shell ([a-z0-9]+)/.exec(started.output)?.[1];
  if (id === undefined) throw new Error(`no shell id in ${started.output}`);
  return { id, output: started.output };
}

async function start(command: string): Promise<string> {
  return (await begin(command)).id;
}

describe("a background command", () => {
  it("returns at once with an id, and keeps running after the call that started it", async () => {
    const before = Date.now();
    const id = await start("sleep 2; echo finished");
    expect(Date.now() - before).toBeLessThan(1_900);

    const running = await run("shell_output", { shell_id: id });
    expect(running.output).toMatch(/^Still running\./);

    const done = await run("shell_output", { shell_id: id, wait_seconds: 5 });
    expect(done.output).toMatch(/^Exited with code 0\.\nfinished/);
  });

  it("runs in the project directory, as a foreground command does", async () => {
    // A command that finishes at once is reported by the start itself — a round trip saved.
    const started = await begin("pwd");
    expect(started.output).toMatch(/Exited with code 0\.\n.*\/home\/user\/app/);
    expect(started.output).toContain(PROJECT_ROOT);
  });

  it("hands over each piece of output once, in order", async () => {
    const started = await begin("echo one; sleep 2; echo two");
    const later = await run("shell_output", { shell_id: started.id, wait_seconds: 5 });

    expect(started.output).toContain("one");
    expect(later.output).toContain("two");
    expect(later.output).not.toContain("one");
    const again = await run("shell_output", { shell_id: started.id });
    expect(again.output).toBe("Exited with code 0.\n(no new output)");
  });

  it("reports a non-zero exit as a fact, not a tool failure", async () => {
    const started = await run("run_command", {
      command: "echo broken >&2; exit 3",
      background: true,
    });
    expect(started.ok).toBe(true);
    expect(started.output).toMatch(/Exited with code 3\.\nbroken/);
  });

  it("says so at once when the command fails on the spot", async () => {
    const started = await run("run_command", {
      command: "no-such-program-anywhere",
      background: true,
    });
    expect(started.output).toMatch(/Exited with code 127/);
  });

  it("takes typed input, which is how a waiting prompt is answered", async () => {
    const id = await start('read -r name; echo "hello $name"');
    const sent = await run("shell_input", { shell_id: id, text: "nap\n" });
    expect(sent.ok).toBe(true);

    const out = await run("shell_output", { shell_id: id, wait_seconds: 5 });
    expect(out.output).toMatch(/Exited with code 0\.\nhello nap/);
  });

  it("refuses input to a command that has already exited, rather than hanging", async () => {
    const id = await start("true");
    await run("shell_output", { shell_id: id, wait_seconds: 5 });

    const sent = await run("shell_input", { shell_id: id, text: "late\n" });
    expect(sent.ok).toBe(false);
    expect(sent.output).toMatch(/already exited/);
  });

  it("stops the command and everything it started", async () => {
    const id = await start("sleep 30 & echo $! > child.pid; sleep 30; echo never");
    const stopped = await run("shell_kill", { shell_id: id });
    expect(stopped.output).toMatch(/Stopped/);

    const out = await run("shell_output", { shell_id: id });
    expect(out.output).toMatch(/^Exited/);
    expect(out.output).not.toContain("never");
    // The background child is the one a careless stop leaves running: it is not the process
    // the shell waits on, only a member of the group it started.
    const child = await sandbox.exec(
      sandbox.id,
      "kill -0 $(cat child.pid) && echo alive || echo gone",
    );
    expect(child.ok && child.value.stdout.trim()).toBe("gone");
  });

  it("names a shell that does not exist instead of reporting nothing", async () => {
    for (const name of ["shell_output", "shell_input", "shell_kill"]) {
      const result = await run(name, {
        shell_id: "abc123",
        ...(name === "shell_input" ? { text: "x" } : {}),
      });
      expect(result.ok).toBe(false);
      expect(result.output).toMatch(/No shell abc123/);
    }
  });

  it("is held to the same rules as a foreground command, typed input included", async () => {
    const started = await run("run_command", { command: "rm -rf /", background: true });
    expect(started.ok).toBe(false);

    const id = await start("cat");
    const typed = await run("shell_input", { shell_id: id, text: "rm -rf /\n" });
    expect(typed.ok).toBe(false);
    await run("shell_kill", { shell_id: id });
  });

  it("splits a long output across reads and says how much is left", async () => {
    const started = await begin("head -c 50000 /dev/zero | tr '\\0' x");
    expect(started.output).toMatch(/30000 more bytes/);
    const second = await run("shell_output", { shell_id: started.id });
    expect(second.output).toMatch(/more bytes/);
    const third = await run("shell_output", { shell_id: started.id });
    expect(third.output).not.toMatch(/more bytes/);
  });
});

describe("a foreground command", () => {
  it("passes its timeout to the sandbox and explains what to do when it is reached", async () => {
    const scripted = new InMemorySandboxManager();
    const created = await scripted.create("p");
    if (!created.ok) throw new Error(created.error.message);
    scripted.script(/slow/, { error: { code: "timeout", message: "deadline" } });
    let seen: number | undefined;
    const exec = scripted.exec.bind(scripted);
    scripted.exec = (id, command, onOutput, options) => {
      seen = options?.timeoutMs;
      return exec(id, command, onOutput, options);
    };

    const result = await executeTool(call("run_command", { command: "slow", timeout_seconds: 5 }), {
      ...context(),
      sandbox: scripted,
      sandboxId: created.value.id,
    });

    expect(seen).toBe(5_000);
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/background/);
  });
});
