import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { estimateContextTokens } from "@nap/shared/compaction";
import type { PendingEvent } from "@nap/shared/ports/event-store";
import type { LLMRequest } from "@nap/shared/ports/llm-provider";
import {
  billedTokens,
  billedWeightsFor,
  FALLBACK_BILLED_WEIGHTS,
  outputTokensFor,
} from "@nap/shared/usage";
import { describe, expect, it } from "vitest";
import { NapAgentService } from "./agent-service.ts";
import { TurnBudget } from "./safety/budget.ts";
import { SubagentPool } from "./subagents.ts";
import { ScriptedLLMProvider, type ScriptedTurn } from "./testing/scripted-llm-provider.ts";
import { PROJECT_ROOT } from "./tools/definitions.ts";

const SESSION = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";
const TURN = "7c9b1a52-8d3e-4f21-a0c4-1b2d3e4f5a6b";
const PATH = `${PROJECT_ROOT}/large.txt`;

async function fixture(script: ScriptedTurn, maxTokens: number, prompt = "Search the repository.") {
  const sandbox = new InMemorySandboxManager();
  const created = await sandbox.create("budget");
  if (!created.ok) throw new Error(created.error.message);
  const provider = new ScriptedLLMProvider([script]);
  const budget = new TurnBudget({ maxTokens });
  const events: PendingEvent[] = [];
  const helpers = new SubagentPool({
    provider,
    budget,
    modelFor: () => "openai/gpt-5.6-luna",
    credentials: undefined,
    prompts: { explore: prompt, general: prompt },
    request: { sessionId: SESSION, turnId: TURN, sandboxId: created.value.id, sandbox },
    emit: (event) => events.push(event),
    now: () => "2026-01-01T00:00:00.000Z",
  });
  return { sandbox, sandboxId: created.value.id, provider, budget, events, helpers };
}

describe("helper request affordability", () => {
  it.each([
    ["anthropic/claude-opus-5", 5],
    ["openai/gpt-5.6-luna", 6],
  ])("caps a helper on %s at that model's output weight, %i", async (model, output) => {
    const sandbox = new InMemorySandboxManager();
    const created = await sandbox.create("budget");
    if (!created.ok) throw new Error(created.error.message);
    const provider = new ScriptedLLMProvider([[{ text: "report" }]], {
      billedWeights: (options) => billedWeightsFor(options.model),
    });
    const budget = new TurnBudget({ maxTokens: 20_000 });
    const helpers = new SubagentPool({
      provider,
      budget,
      modelFor: () => model,
      credentials: undefined,
      prompts: { explore: "Search.", general: "Search." },
      request: { sessionId: SESSION, turnId: TURN, sandboxId: created.value.id, sandbox },
      emit: () => {},
      now: () => "2026-01-01T00:00:00.000Z",
    });

    expect((await helpers.run({ toolCallId: "sub", profile: "explore", task: "Look." })).ok).toBe(
      true,
    );

    const [sent] = provider.requests;
    if (sent === undefined) throw new Error("the helper sent nothing");
    // Half the turn's 20k is the helper's share; its input is priced uncached, the rest is output.
    const weights = billedWeightsFor(model);
    expect(weights.output).toBe(output);
    expect(sent.maxOutputTokens).toBe(
      outputTokensFor(10_000 - estimateContextTokens(sent), weights),
    );
  });

  it.each(["task", "system prompt", "tool schemas"] as const)(
    "refuses an initial request whose %s cannot fit the share",
    async (large) => {
      const { helpers, provider, budget } = await fixture(
        [{ text: "must not send" }],
        large === "tool schemas" ? 100 : large === "task" ? 2_000 : 10_000,
        large === "system prompt" ? "rules\n".repeat(5_000) : "Search.",
      );
      const report = await helpers.run({
        toolCallId: "sub",
        profile: "explore",
        task: large === "task" ? "q".repeat(4_000) : "Find routes.",
      });
      expect(provider.requests).toHaveLength(0);
      expect(report.ok).toBe(false);
      expect(report.output).toMatch(/budget|allowance/i);
      expect(budget.spent().tokens).toBe(0);
    },
  );

  it("counts accumulated tool results before buying a second request", async () => {
    const first = { inputTokens: 3_900, outputTokens: 100 };
    const { helpers, sandbox, sandboxId, provider, budget } = await fixture(
      [
        {
          toolCalls: [{ id: "read", name: "read_file", input: { path: PATH } }],
          usage: first,
        },
        { text: "must not send" },
      ],
      20_000,
    );
    // Many short lines survive the reader's per-line truncation.
    await sandbox.writeFile(sandboxId, PATH, `${"x".repeat(100)}\n`.repeat(1_000));
    const report = await helpers.run({
      toolCallId: "sub",
      profile: "explore",
      task: "Read the large file.",
    });
    expect(provider.requests).toHaveLength(1);
    expect(report.ok).toBe(false);
    expect(report.output).toMatch(/budget|allowance/i);
    expect(budget.spent().tokens).toBe(billedTokens(first, FALLBACK_BILLED_WEIGHTS));
  });

  it("caps each output using the full next input and the remaining allowance", async () => {
    const first = { inputTokens: 1_500, outputTokens: 100 };
    const { helpers, provider } = await fixture(
      [
        {
          toolCalls: [{ id: "list", name: "list_files", input: { path: PROJECT_ROOT } }],
          usage: first,
        },
        { text: "report", usage: { inputTokens: 1_600, outputTokens: 20 } },
      ],
      20_000,
    );
    expect(
      (await helpers.run({ toolCallId: "sub", profile: "explore", task: "List the files." })).ok,
    ).toBe(true);
    expect(provider.requests).toHaveLength(2);
    for (const [index, sent] of provider.requests.entries()) {
      const cap = sent.maxOutputTokens;
      expect(cap).toBeDefined();
      if (cap === undefined) throw new Error("Missing helper output cap");
      expect(Number.isInteger(cap)).toBe(true);
      expect(cap).toBeGreaterThan(0);
      // Priced as the budget prices it: output at its own rate, input as if uncached.
      expect(
        billedTokens(
          { inputTokens: estimateContextTokens(sent), outputTokens: cap },
          FALLBACK_BILLED_WEIGHTS,
        ),
      ).toBeLessThanOrEqual(
        10_000 - (index === 0 ? 0 : billedTokens(first, FALLBACK_BILLED_WEIGHTS)),
      );
    }
  });

  it.each(["final report", "tool call"] as const)(
    "accounts actual overrun and rejects a %s before success or mutations",
    async (reply) => {
      const usage = { inputTokens: 20_001, outputTokens: 31 };
      const { helpers, provider, sandbox, sandboxId, budget, events } = await fixture(
        [
          reply === "final report"
            ? { text: "unaffordable report", usage }
            : {
                toolCalls: [
                  {
                    id: "write",
                    name: "write_file",
                    input: { path: PATH, contents: "must not write" },
                  },
                ],
                usage,
              },
          { text: "must not send" },
        ],
        20_000,
      );
      const report = await helpers.run({
        toolCallId: "sub",
        profile: "general",
        task: "Inspect the task.",
      });
      expect(report.ok).toBe(false);
      expect(report.output).toMatch(/budget|allowance/i);
      expect(provider.requests).toHaveLength(1);
      expect(helpers.usage()).toEqual(usage);
      expect(budget.spent().tokens).toBe(billedTokens(usage, FALLBACK_BILLED_WEIGHTS));
      expect((await sandbox.readFile(sandboxId, PATH)).ok).toBe(false);
      expect(events.filter((event) => event.type === "file.changed")).toEqual([]);
      expect(events.at(-1)).toMatchObject({
        type: "subagent.completed",
        payload: { outcome: "failed", usage, toolCalls: 0 },
      });
    },
  );

  it("fails a report over its own share even while the parent still has tokens", async () => {
    const { helpers, budget } = await fixture(
      [{ text: "over share", usage: { inputTokens: 10_001, outputTokens: 0 } }],
      20_000,
    );
    const report = await helpers.run({
      toolCallId: "sub",
      profile: "explore",
      task: "Find routes.",
    });
    expect(report.ok).toBe(false);
    expect(budget.check().ok).toBe(true);
    expect(budget.spent().tokens).toBe(10_001);
  });

  it.each(["completed", "refusal", "error", "cancelled"] as const)(
    "holds only unspent promises and releases them after %s",
    async (ending) => {
      const first = { inputTokens: 1_500, outputTokens: 100 };
      const { helpers, sandbox, sandboxId, budget } = await fixture(
        [
          {
            toolCalls: [{ id: "read", name: "read_file", input: { path: PATH } }],
            usage: first,
          },
          ending === "refusal"
            ? { refusal: true, usage: { inputTokens: 100, outputTokens: 0 } }
            : ending === "error"
              ? {
                  error: { message: "Unavailable", retryable: false },
                  usage: { inputTokens: 100, outputTokens: 0 },
                }
              : { text: "report", usage: { inputTokens: 100, outputTokens: 0 } },
        ],
        20_000,
      );
      await sandbox.writeFile(sandboxId, PATH, "content\n");
      let entered: () => void = () => {};
      let release: () => void = () => {};
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const read = sandbox.readFile.bind(sandbox);
      sandbox.readFile = async (id, path) => {
        if (path === PATH) {
          entered();
          await held;
        }
        return read(id, path);
      };
      const report = helpers.run({ toolCallId: "sub", profile: "explore", task: "Read the file." });
      await started;
      try {
        expect(budget.spent().tokens).toBe(billedTokens(first, FALLBACK_BILLED_WEIGHTS));
        // What is already spent must not also stay inside the original 10000 promise.
        expect(helpers.availableTokens()).toBe(10_000);
        if (ending === "cancelled") await helpers.settle();
      } finally {
        release();
        await report;
      }
      expect((await report).ok).toBe(ending === "completed");
      expect(budget.spent().tokens).toBe(
        billedTokens(first, FALLBACK_BILLED_WEIGHTS) + (ending === "cancelled" ? 0 : 100),
      );
      expect(helpers.availableTokens()).toBe(budget.remaining().tokens);
    },
  );

  it("does not let the parent and a pending background helper spend the same reservation", async () => {
    const sandbox = new InMemorySandboxManager();
    const created = await sandbox.create("parent-budget");
    if (!created.ok) throw new Error(created.error.message);
    const maxTokens = 40_000;
    const initialUsage = { inputTokens: 100, outputTokens: 10 };
    const provider = new ScriptedLLMProvider([
      [
        {
          toolCalls: [
            {
              id: "sub",
              name: "run_subagent",
              input: { profile: "explore", task: "Find routes.", background: true },
            },
          ],
          usage: initialUsage,
        },
        {
          toolCalls: [{ id: "collect", name: "read_subagent", input: { subagent_id: "helper-1" } }],
        },
        { text: "done" },
      ],
      [{ text: "routes found" }],
    ]);
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: () => void = () => {};
    const helperEntered = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const start = provider.startTurn.bind(provider);
    let started = 0;
    let helperRequest: LLMRequest | undefined;
    let parentRequest: LLMRequest | undefined;
    let helperPending = false;
    let concurrent = false;
    provider.startTurn = (options) => {
      const turn = start(options);
      const isHelper = ++started === 2;
      const complete = turn.complete.bind(turn);
      let calls = 0;
      turn.complete = async (sent) => {
        calls += 1;
        if (isHelper) {
          helperPending = true;
          helperRequest = { ...sent, messages: structuredClone(sent.messages) };
          entered();
          await held;
        } else if (calls === 2) {
          parentRequest = { ...sent, messages: structuredClone(sent.messages) };
          concurrent = helperPending;
        }
        const result = await complete(sent);
        if (isHelper) helperPending = false;
        return result;
      };
      return turn;
    };
    const agent = new NapAgentService({ provider, budget: { maxTokens } });
    const running = agent.runTurn({
      sessionId: SESSION,
      turnId: TURN,
      sandboxId: created.value.id,
      sandbox,
      context: {
        systemPrompt: "Coordinate the search.",
        estimatedTokens: 10,
        messages: [{ role: "user", content: "Find routes." }],
        subagentPrompts: { explore: "Search.", general: "Build." },
      },
      onEvent: () => {},
    });
    try {
      await helperEntered;
      // Give the parent a chance to request its next step while the helper is pending.
      await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
      release();
    }
    await running;
    expect(helperRequest).toBeDefined();
    expect(parentRequest).toBeDefined();
    if (helperRequest === undefined || parentRequest === undefined)
      throw new Error("Missing concurrent requests");
    const helperCap = helperRequest.maxOutputTokens;
    expect(helperCap).toBeDefined();
    if (helperCap === undefined) throw new Error("Missing helper output cap");
    const remaining = maxTokens - billedTokens(initialUsage, FALLBACK_BILLED_WEIGHTS);
    const promised = Math.floor(remaining / 2);
    const cost = (sent: LLMRequest, cap: number) =>
      billedTokens(
        { inputTokens: estimateContextTokens(sent), outputTokens: cap },
        FALLBACK_BILLED_WEIGHTS,
      );
    expect(cost(helperRequest, helperCap)).toBeLessThanOrEqual(promised);
    if (concurrent) {
      const parentCap = parentRequest.maxOutputTokens;
      expect(parentCap).toBeDefined();
      if (parentCap === undefined) throw new Error("Missing concurrent parent output cap");
      expect(cost(parentRequest, parentCap)).toBeLessThanOrEqual(remaining - promised);
    }
  });
});
