import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import type { PendingEvent } from "@nap/shared/ports/event-store";
import { describe, expect, it } from "vitest";
import { TurnBudget } from "./safety/budget.ts";
import { SubagentPool } from "./subagents.ts";
import { ScriptedLLMProvider, type ScriptedTurn } from "./testing/scripted-llm-provider.ts";
import { PROJECT_ROOT } from "./tools/definitions.ts";
import { executeTool } from "./tools/execute.ts";

async function pool(turns: ScriptedTurn[], maxTokens: number) {
  const sandbox = new InMemorySandboxManager();
  const created = await sandbox.create("p");
  if (!created.ok) throw new Error(created.error.message);
  await sandbox.writeFile(created.value.id, `${PROJECT_ROOT}/a.ts`, "a\n");
  const events: PendingEvent[] = [];
  const helpers = new SubagentPool({
    provider: new ScriptedLLMProvider(turns),
    models: { explore: undefined, general: undefined },
    credentials: undefined,
    prompts: { explore: "search", general: "build" },
    family: "claude",
    budget: new TurnBudget({ maxTokens }),
    request: {
      sessionId: "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77",
      turnId: "7c9b1a52-8d3e-4f21-a0c4-1b2d3e4f5a6b",
      sandboxId: created.value.id,
      sandbox,
    },
    emit: (event) => events.push(event as PendingEvent),
    now: () => "2026-01-01T00:00:00.000Z",
  });
  return { helpers, events, sandbox, sandboxId: created.value.id };
}

const READ = { id: "r", name: "read_file", input: { path: `${PROJECT_ROOT}/a.ts` } };

describe("SubagentPool", () => {
  it("shares the turn's budget between helpers running at once, rather than promising it twice", async () => {
    // Of 1000 tokens, the first helper may spend half (500) and the second half of what is left
    // unpromised (250). Each spends 260 on its first request: enough to stop only the second.
    const step = { toolCalls: [READ], usage: { inputTokens: 260, outputTokens: 0 } };
    const { helpers } = await pool(
      [
        [step, { text: "first report" }],
        [step, { text: "never" }],
      ],
      1_000,
    );

    const first = helpers.start({ toolCallId: "a", profile: "explore", task: "one" });
    const second = helpers.start({ toolCallId: "b", profile: "explore", task: "two" });

    expect(await helpers.collect(second)).toEqual({
      ok: false,
      output: expect.stringMatching(/budget cannot cover/),
    });
    expect(await helpers.collect(first)).toEqual({
      ok: true,
      output: "Report from helper-1:\nfirst report",
    });
  });

  it("gives back what a finished helper was promised", async () => {
    const { helpers } = await pool(
      [
        [{ text: "one", usage: { inputTokens: 10, outputTokens: 0 } }],
        [{ toolCalls: [READ], usage: { inputTokens: 260, outputTokens: 0 } }, { text: "two" }],
      ],
      1_000,
    );
    await helpers.run({ toolCallId: "a", profile: "explore", task: "one" });
    // Promised (1000 - 10) / 2 = 495 now, not a quarter.
    expect(await helpers.run({ toolCallId: "b", profile: "explore", task: "two" })).toEqual({
      ok: true,
      output: "Report from helper-2:\ntwo",
    });
  });

  it("says when asked for a helper it never started", async () => {
    const { helpers } = await pool([], 1_000);
    expect(await helpers.collect("helper-9")).toEqual({
      ok: false,
      output: "No helper helper-9 was started in this turn.",
    });
  });
});

describe("run_subagent", () => {
  it("keeps a helper that writes in the foreground, so it never edits beside the agent", async () => {
    const { helpers, sandbox, sandboxId, events } = await pool([], 1_000);
    const result = await executeTool(
      {
        id: "g",
        name: "run_subagent",
        input: { profile: "general", task: "edit", background: true },
      },
      {
        sessionId: "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77",
        turnId: "7c9b1a52-8d3e-4f21-a0c4-1b2d3e4f5a6b",
        sandboxId,
        sandbox,
        subagents: helpers,
        emit: (event) => events.push(event as PendingEvent),
      },
    );
    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/Only an explore helper can run in the background/);
    expect(events.map((event) => event.type)).not.toContain("subagent.started");
  });
});
