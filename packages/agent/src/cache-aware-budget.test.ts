import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { estimateContextTokens } from "@nap/shared/compaction";
import type { AgentTurnRequest } from "@nap/shared/ports/agent-service";
import type { PendingEvent } from "@nap/shared/ports/event-store";
import type { LLMProvider, LLMTurnOptions, TokenUsage } from "@nap/shared/ports/llm-provider";
import { billedWeightsFor, MODEL_BILLED_WEIGHTS, outputTokensFor } from "@nap/shared/usage";
import { beforeEach, describe, expect, it } from "vitest";
import { NapAgentService } from "./agent-service.ts";
import {
  ScriptedLLMProvider,
  type ScriptedResponse,
  type ScriptedTurn,
} from "./testing/scripted-llm-provider.ts";

/**
 * The turn budget charges what a request is billed at, and compaction answers only to the size
 * of the context — two different questions, which the loop once answered with one number.
 *
 * Every usage here is scripted, so these are statements about the loop's arithmetic and not
 * about any model: a turn whose cache works runs long and is left alone; a context that really
 * grows is compacted when it fills; and a turn that spends without limit is still stopped.
 */

const SESSION_ID = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";
const TURN_ID = "7c9b1a52-8d3e-4f21-a0c4-1b2d3e4f5a6b";

/** The context ceiling `NAP_CONTEXT_BUDGET_TOKENS` defaults to. */
const CONTEXT_CEILING = 120_000;

let manager: InMemorySandboxManager;
let sandboxId: string;
let events: PendingEvent[];

beforeEach(async () => {
  manager = new InMemorySandboxManager();
  const created = await manager.create("project");
  if (!created.ok) throw new Error(created.error.message);
  sandboxId = created.value.id;
  events = [];
});

/** One round trip that lists a directory and reports `usage`, so the loop goes round again. */
function step(index: number, usage: TokenUsage): ScriptedResponse {
  return {
    toolCalls: [{ id: `call-${index}`, name: "list_files", input: { path: "/home/user/app" } }],
    usage,
  };
}

/** A request whose cache works: it re-reads the prompt so far and writes what was added. */
function cached(context: number, added: number, output: number): TokenUsage {
  return {
    inputTokens: context,
    outputTokens: output,
    cacheReadTokens: context - added,
    cacheWriteTokens: added,
  };
}

type Compaction = { trigger: string; afterRequests: number };

function turn(
  provider: LLMProvider & { requests: readonly unknown[] },
  options: { budgetTokens: number; maxTokens?: number },
) {
  const compactions: Compaction[] = [];
  const agent = new NapAgentService({
    provider,
    ...(options.maxTokens === undefined ? {} : { budget: { maxTokens: options.maxTokens } }),
  });
  const request: AgentTurnRequest = {
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    sandboxId,
    sandbox: manager,
    onEvent: (event) => events.push(event),
    context: {
      systemPrompt: "You are editing a React project.",
      messages: [{ role: "user", content: "Build the settings page." }],
      estimatedTokens: 20,
      budgetTokens: options.budgetTokens,
    },
    compactContext: async (input) => {
      compactions.push({ trigger: input.trigger, afterRequests: provider.requests.length });
      return { ok: true, messages: [{ role: "user", content: "Build the settings page." }] };
    },
  };
  return { run: () => agent.runTurn(request), compactions };
}

function payloadOf(type: PendingEvent["type"]): unknown {
  return events.find((event) => event.type === type)?.payload;
}

function completedUsage(): unknown {
  const completed = events.find((event) => event.type === "turn.completed");
  return completed?.type === "turn.completed" ? completed.payload.usage : undefined;
}

describe("a turn whose cache is working", () => {
  it("runs well past thirteen steps on the default budget and never compacts", async () => {
    // 30k of context, re-read from the cache on every request and grown by each step's result.
    // Charged at face value this turn ran out around its eleventh step, and the cost-driven
    // compaction trigger fired at its seventh and threw the warm cache away.
    const steps = 30;
    const script: ScriptedTurn = [
      ...Array.from({ length: steps }, (_, i) => step(i, cached(30_000 + i * 1_500, 2_300, 800))),
      { text: "Done.", usage: cached(30_000 + steps * 1_500, 2_300, 200) },
    ];
    const provider = new ScriptedLLMProvider([script]);
    const { run, compactions } = turn(provider, { budgetTokens: CONTEXT_CEILING });

    await run();

    expect(payloadOf("turn.failed")).toBeUndefined();
    expect(compactions).toEqual([]);
    expect(provider.requests).toHaveLength(steps + 1);
  });

  it("reports the turn's cache split, summed across its requests, when it completes", async () => {
    const provider = new ScriptedLLMProvider([
      [step(0, cached(10_000, 10_000, 100)), { text: "Done.", usage: cached(11_000, 1_000, 50) }],
    ]);
    const { run } = turn(provider, { budgetTokens: CONTEXT_CEILING });

    await run();

    expect(completedUsage()).toStrictEqual({
      inputTokens: 21_000,
      outputTokens: 150,
      cacheWriteTokens: 11_000,
      cacheReadTokens: 10_000,
    });
  });
});

describe("the context meter", () => {
  it("shows the whole prompt a cached request carried, not the uncached remainder", async () => {
    // The pane's Context control reads this. A request that read 29.7k of its 30k prompt from
    // the cache is still a 30k prompt, and a meter showing 300 would say the context was empty.
    const provider = new ScriptedLLMProvider([
      [step(0, cached(30_000, 300, 100)), { text: "Done.", usage: cached(31_000, 1_000, 10) }],
    ]);
    const { run } = turn(provider, { budgetTokens: CONTEXT_CEILING });

    await run();

    const reported = events.flatMap((event) =>
      event.type === "context.usage" && event.payload.source === "reported"
        ? [event.payload.inputTokens]
        : [],
    );
    expect(reported[0]).toBe(30_000);
  });
});

describe("a context that genuinely grows", () => {
  /** Each request 15k bigger than the last, none of it from the cache. */
  const growing = (requests: number): ScriptedTurn => [
    ...Array.from({ length: requests }, (_, i) =>
      step(i, { inputTokens: 20_000 + i * 15_000, outputTokens: 500 }),
    ),
    { text: "Done.", usage: { inputTokens: 4_000, outputTokens: 100 } },
  ];

  it("is compacted when it reaches the context ceiling, and not before", async () => {
    // A budget too large to matter, so nothing but the context's size can be what fires. The
    // eighth response reports 125k against a 120k ceiling; the seventh's 110k leaves room for
    // a reply.
    const provider = new ScriptedLLMProvider([growing(8)]);
    const { run, compactions } = turn(provider, {
      budgetTokens: CONTEXT_CEILING,
      maxTokens: 100_000_000,
    });

    await run();

    expect(compactions).toEqual([{ trigger: "automatic", afterRequests: 8 }]);
    expect(payloadOf("turn.failed")).toBeUndefined();
  });

  it("is compacted when it reaches the model's window, even under a roomier ceiling", async () => {
    const scripted = new ScriptedLLMProvider([growing(8)]);
    // `Object.assign` rather than a spread: the handle's methods live on its prototype.
    const provider = Object.assign(scripted, {
      startTurn: () =>
        Object.assign(ScriptedLLMProvider.prototype.startTurn.call(scripted), {
          contextWindowTokens: 130_000,
        }),
    });
    const { run, compactions } = turn(provider, {
      budgetTokens: 1_000_000,
      maxTokens: 100_000_000,
    });

    await run();

    expect(compactions).toEqual([{ trigger: "automatic", afterRequests: 8 }]);
  });
});

describe("a runaway turn", () => {
  it("is still stopped by the budget long before its step limit", async () => {
    // Every request pays full price for a 60k prompt and writes 2k: the step limit alone would
    // let forty of these through.
    const script = Array.from({ length: 40 }, (_, i) =>
      step(i, { inputTokens: 60_000, outputTokens: 2_000 }),
    );
    const provider = new ScriptedLLMProvider([script]);
    const { run, compactions } = turn(provider, { budgetTokens: CONTEXT_CEILING });

    await run();

    expect(payloadOf("turn.failed")).toMatchObject({ reason: "budget_exceeded" });
    expect(provider.requests.length).toBeLessThan(20);
    expect(compactions).toEqual([]);
  });
});

describe("each model's usage is charged at that model's weights", () => {
  const OPUS = "anthropic/claude-opus-5";
  const LUNA = "openai/gpt-5.6-luna";
  /** As `ClaudeProvider` does: the known row for a priced model, nothing for any other. */
  const resolved = (options: LLMTurnOptions) =>
    options.model !== undefined && Object.hasOwn(MODEL_BILLED_WEIGHTS, options.model)
      ? billedWeightsFor(options.model)
      : undefined;
  const hundredOut: ScriptedResponse = {
    text: "Done.",
    usage: { inputTokens: 0, outputTokens: 100 },
  };

  function run(
    script: ScriptedTurn[],
    options: {
      model: string;
      maxTokens: number;
      fallbackModel?: string;
      subagents?: boolean;
    },
  ) {
    const provider = new ScriptedLLMProvider(script, { billedWeights: resolved });
    const agent = new NapAgentService({
      provider,
      budget: { maxTokens: options.maxTokens },
      ...(options.fallbackModel === undefined ? {} : { fallbackModel: options.fallbackModel }),
    });
    const request: AgentTurnRequest = {
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      sandboxId,
      sandbox: manager,
      model: options.model,
      onEvent: (event) => events.push(event),
      context: {
        systemPrompt: "You are editing a React project.",
        messages: [{ role: "user", content: "Build the settings page." }],
        estimatedTokens: 20,
        ...(options.subagents === true
          ? { subagentPrompts: { explore: "You search.", general: "You build." } }
          : {}),
      },
    };
    return { provider, done: agent.runTurn(request) };
  }

  it.each([
    [OPUS, undefined],
    [LUNA, "token budget exceeded: 600 billed tokens spent, limit 550"],
    ["vendor/unpriced", "token budget exceeded: 600 billed tokens spent, limit 550"],
  ])("charges a hundred output tokens on %s at its own output ratio", async (model, failure) => {
    // 500 on Anthropic's model, 600 on OpenAI's, and the fallback's 600 on a model nobody priced.
    await run([[hundredOut]], { model, maxTokens: 550 }).done;

    if (failure === undefined) {
      expect(payloadOf("turn.failed")).toBeUndefined();
      expect(payloadOf("turn.completed")).toBeDefined();
    } else
      expect(payloadOf("turn.failed")).toEqual({ reason: "budget_exceeded", message: failure });
  });

  it("charges what a fallback model answers at the fallback's weights, not the refusing model's", async () => {
    // 100 out on Opus (500) and 100 out on Luna (600). Charged at the refusing turn's weights
    // the pair would be 1,000 and fit the ceiling.
    await run([[{ refusal: true, usage: { inputTokens: 0, outputTokens: 100 } }], [hundredOut]], {
      model: OPUS,
      fallbackModel: LUNA,
      maxTokens: 1_050,
    }).done;

    expect(payloadOf("turn.failed")).toEqual({
      reason: "budget_exceeded",
      message: "token budget exceeded: 1100 billed tokens spent, limit 1050",
    });
  });

  it.each([
    [OPUS, 5],
    [LUNA, 6],
  ])(
    "caps the lead's output on %s at its own output weight while helpers can hold promises",
    async (model, output) => {
      const { provider, done } = run([[hundredOut]], {
        model,
        maxTokens: 120_000,
        subagents: true,
      });
      await done;

      const [sent] = provider.requests;
      if (sent === undefined) throw new Error("the lead sent nothing");
      // Nothing spent or promised yet, so all of the budget less the input, priced uncached.
      const weights = billedWeightsFor(model);
      expect(weights.output).toBe(output);
      expect(sent.maxOutputTokens).toBe(
        outputTokensFor(120_000 - estimateContextTokens(sent), weights),
      );
    },
  );
});
