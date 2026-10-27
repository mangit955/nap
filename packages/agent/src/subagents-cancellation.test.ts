import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import type { PendingEvent } from "@nap/shared/ports/event-store";
import type { LLMToolCall } from "@nap/shared/ports/llm-provider";
import { describe, expect, it } from "vitest";
import { TurnBudget } from "./safety/budget.ts";
import { SubagentPool } from "./subagents.ts";
import { ScriptedLLMProvider, type ScriptedTurn } from "./testing/scripted-llm-provider.ts";
import { PROJECT_ROOT } from "./tools/definitions.ts";

function gate() {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const FIRST = `${PROJECT_ROOT}/first.ts`;
const SECOND = `${PROJECT_ROOT}/second.ts`;
const nextTask = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("mutating helper cancellation", () => {
  it("drains an already dispatched foreground command before settlement", async () => {
    const sandbox = new InMemorySandboxManager();
    const created = await sandbox.create("command-cancellation");
    if (!created.ok) throw new Error(created.error.message);
    const entered = gate();
    const held = gate();
    let commandDone = false;
    sandbox.exec = async () => {
      entered.release();
      await held.promise;
      await sandbox.writeFile(created.value.id, FIRST, "command effect\n");
      commandDone = true;
      return { ok: true, value: { exitCode: 0, stdout: "", stderr: "" } };
    };
    const events: PendingEvent[] = [];
    const helpers = new SubagentPool({
      provider: new ScriptedLLMProvider([
        [
          {
            toolCalls: [
              { id: "command", name: "run_command", input: { command: "touch first.ts" } },
              {
                id: "write",
                name: "write_file",
                input: { path: SECOND, contents: "must not write" },
              },
            ],
          },
        ],
      ]),
      modelFor: () => "openai/gpt-5.6-luna",
      credentials: undefined,
      prompts: { explore: "search", general: "build" },
      budget: new TurnBudget({ maxTokens: 100_000 }),
      request: {
        sessionId: "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77",
        turnId: "7c9b1a52-8d3e-4f21-a0c4-1b2d3e4f5a6b",
        sandboxId: created.value.id,
        sandbox,
      },
      emit: (event) => events.push(event),
      now: () => "2026-01-01T00:00:00.000Z",
    });
    const report = helpers.run({ toolCallId: "sub", profile: "general", task: "Run the command." });
    await entered.promise;
    let settled = false;
    const settlement = helpers.settle().then(() => {
      settled = true;
    });
    let whileHeld = { settled: false, commandDone: false, completed: false };
    try {
      await nextTask();
      whileHeld = {
        settled,
        commandDone,
        completed: events.some((event) => event.type === "subagent.completed"),
      };
    } finally {
      held.release();
      await settlement;
    }
    expect(whileHeld).toEqual({ settled: false, commandDone: false, completed: false });
    expect((await report).ok).toBe(false);
    expect(commandDone).toBe(true);
    expect(await sandbox.readFile(created.value.id, FIRST)).toEqual({
      ok: true,
      value: "command effect\n",
    });
    expect((await sandbox.readFile(created.value.id, SECOND)).ok).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "subagent.completed",
      payload: { outcome: "cancelled" },
    });
  });

  it.each([
    ["write_file", "pre-read"],
    ["write_file", "write"],
    ["edit_file", "pre-read"],
    ["edit_file", "write"],
    ["apply_patch", "pre-read"],
    ["apply_patch", "write"],
  ] as const)("drains %s at its %s and starts no later mutation", async (tool, heldAt) => {
    const sandbox = new InMemorySandboxManager();
    const created = await sandbox.create("cancellation");
    if (!created.ok) throw new Error(created.error.message);
    const sandboxId = created.value.id;
    if (tool === "edit_file") {
      await sandbox.writeFile(sandboxId, FIRST, "before\n");
      await sandbox.writeFile(sandboxId, SECOND, "before\n");
    }
    const readCall = (path: string): LLMToolCall => ({
      id: `read-${path}`,
      name: "read_file",
      input: { path },
    });
    const mutation = (path: string): LLMToolCall =>
      tool === "edit_file"
        ? { id: path, name: tool, input: { path, old_string: "before", new_string: "after" } }
        : { id: path, name: "write_file", input: { path, contents: "after\n" } };
    const script: ScriptedTurn = [
      ...(tool === "edit_file" ? [{ toolCalls: [readCall(FIRST), readCall(SECOND)] }] : []),
      {
        toolCalls:
          tool === "apply_patch"
            ? [
                {
                  id: "patch",
                  name: tool,
                  input: {
                    patch: [
                      "*** Begin Patch",
                      "*** Add File: first.ts",
                      "+after",
                      "*** Add File: second.ts",
                      "+after",
                      "*** End Patch",
                    ].join("\n"),
                  },
                },
              ]
            : [mutation(FIRST), mutation(SECOND)],
      },
      { text: "unexpected success" },
    ];
    const entered = gate();
    const held = gate();
    const read = sandbox.readFile.bind(sandbox);
    const write = sandbox.writeFile.bind(sandbox);
    let firstReads = 0;
    let pending = false;
    const writes: string[] = [];
    sandbox.readFile = async (id, path) => {
      if (path === FIRST) {
        firstReads += 1;
        if (heldAt === "pre-read" && firstReads === (tool === "edit_file" ? 2 : 1)) {
          pending = true;
          entered.release();
          await held.promise;
          pending = false;
        }
      }
      return read(id, path);
    };
    sandbox.writeFile = async (id, path, contents) => {
      writes.push(path);
      if (path === FIRST && heldAt === "write") {
        pending = true;
        entered.release();
        await held.promise;
      }
      const result = await write(id, path, contents);
      pending = false;
      return result;
    };
    const controller = new AbortController();
    const events: PendingEvent[] = [];
    const helpers = new SubagentPool({
      provider: new ScriptedLLMProvider([script]),
      modelFor: () => "openai/gpt-5.6-luna",
      credentials: undefined,
      prompts: { explore: "search", general: "build" },
      budget: new TurnBudget({ maxTokens: 100_000 }),
      request: {
        sessionId: "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77",
        turnId: "7c9b1a52-8d3e-4f21-a0c4-1b2d3e4f5a6b",
        sandboxId,
        sandbox,
        signal: controller.signal,
      },
      emit: (event) => events.push(event),
      now: () => "2026-01-01T00:00:00.000Z",
    });
    let reported = false;
    let settled = false;
    const report = helpers.run({
      toolCallId: "sub",
      profile: "general",
      task: "Change both files.",
    });
    void report.then(() => {
      reported = true;
    });
    await entered.promise;
    controller.abort();
    const settlement = helpers.settle().then(() => {
      settled = true;
    });
    let whileHeld = { pending: false, reported: false, settled: false, completed: false };
    try {
      // A task boundary lets every cancellation continuation run while the I/O stays held.
      await nextTask();
      whileHeld = {
        pending,
        reported,
        settled,
        completed: events.some((event) => event.type === "subagent.completed"),
      };
    } finally {
      held.release();
      await settlement;
      await report;
      await nextTask();
    }

    expect(whileHeld).toEqual({ pending: true, reported: false, settled: false, completed: false });
    expect(await report).toEqual({ ok: false, output: expect.stringMatching(/cancelled/) });
    expect(writes).toEqual(heldAt === "write" ? [FIRST] : []);
    expect(await read(sandboxId, SECOND)).toEqual(
      tool === "edit_file"
        ? { ok: true, value: "before\n" }
        : { ok: false, error: expect.objectContaining({ code: "file_not_found" }) },
    );
    expect(await read(sandboxId, FIRST)).toEqual(
      heldAt === "write"
        ? { ok: true, value: "after\n" }
        : tool === "edit_file"
          ? { ok: true, value: "before\n" }
          : { ok: false, error: expect.objectContaining({ code: "file_not_found" }) },
    );
    const changed = events.filter((event) => event.type === "file.changed");
    expect(changed).toHaveLength(heldAt === "write" ? 1 : 0);
    if (heldAt === "write") {
      expect(changed[0]).toMatchObject({ payload: { path: FIRST } });
      expect(events.indexOf(changed[0]!)).toBeLessThan(
        events.findIndex((event) => event.type === "subagent.completed"),
      );
    }
    const atSettlement = await read(sandboxId, FIRST);
    const eventsAtSettlement = [...events];
    await nextTask();
    expect(await read(sandboxId, FIRST)).toEqual(atSettlement);
    expect(events).toEqual(eventsAtSettlement);
  });
});
