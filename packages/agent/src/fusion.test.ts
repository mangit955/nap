import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import {
  type CompactContext,
  estimateContextTokens,
  isUsableSummary,
} from "@nap/shared/compaction";
import { NapEventSchema } from "@nap/shared/events";
import type { AgentTurnRequest } from "@nap/shared/ports/agent-service";
import type { PendingEvent } from "@nap/shared/ports/event-store";
import type {
  LLMProvider,
  LLMRequest,
  LLMToolCall,
  LLMTurn,
  LLMTurnResult,
} from "@nap/shared/ports/llm-provider";
import { beforeEach, describe, expect, it } from "vitest";
import { NapAgentService } from "./agent-service.ts";
import {
  ScriptedLLMProvider,
  type ScriptedResponse,
  type ScriptedTurn,
} from "./testing/scripted-llm-provider.ts";
import { PROJECT_ROOT } from "./tools/definitions.ts";

/**
 * Fusion: a cheaper sidekick model does the turn's condensing work — explore helpers and
 * compaction summaries — and the lead model does everything else (ADR-0030).
 *
 * What is asserted is who received which request, what reached the budget and the log, and that a
 * sidekick that fails in any way leaves the lead doing exactly what it did before Fusion existed.
 */

const SESSION_ID = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";
const TURN_ID = "7c9b1a52-8d3e-4f21-a0c4-1b2d3e4f5a6b";
const APP = `${PROJECT_ROOT}/src/App.tsx`;
const LEAD = "anthropic/claude-opus-5";
const SIDEKICK = "openai/gpt-5.6-luna";
const FREE_LEAD = "poolside/laguna-s-2.1:free";
const PROMPTS = { explore: "You search.", general: "You build." };
const SUMMARY_REQUEST: LLMRequest = {
  purpose: "compaction",
  systemPrompt: "Condense this.",
  messages: [{ role: "user", content: '{"transcriptFragment":"#1 user: build it"}' }],
  tools: [],
  maxOutputTokens: 100,
};

let manager: InMemorySandboxManager;
let sandboxId: string;
let events: PendingEvent[];

beforeEach(async () => {
  manager = new InMemorySandboxManager();
  const created = await manager.create("project");
  if (!created.ok) throw new Error(created.error.message);
  sandboxId = created.value.id;
  events = [];
  await manager.writeFile(sandboxId, APP, "app\n");
});

function request(overrides: Partial<AgentTurnRequest> = {}): AgentTurnRequest {
  return {
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    sandboxId,
    sandbox: manager,
    model: LEAD,
    context: {
      systemPrompt: "You edit a React app.",
      messages: [{ role: "user", content: "Where are routes declared?" }],
      estimatedTokens: 10,
      subagentPrompts: PROMPTS,
    },
    onEvent: (event) => events.push(event),
    ...overrides,
  };
}

/**
 * A compaction whose summary is `chunks` requests, each sent with the turn's signal and checked
 * with the rule the runtime's compactor uses.
 */
function compaction(chunks = 1): { compactContext: CompactContext; summaries: LLMTurnResult[] } {
  const summaries: LLMTurnResult[] = [];
  return {
    summaries,
    // As the runtime's compactor does, a throw becomes a failed compaction, never an escape.
    compactContext: async (input) => {
      try {
        for (let chunk = 0; chunk < chunks; chunk += 1) {
          const result = await input.complete({
            ...SUMMARY_REQUEST,
            ...(input.signal === undefined ? {} : { signal: input.signal }),
          });
          if (!isUsableSummary(result)) return { ok: false, message: "no summary" };
          summaries.push(result);
        }
        return { ok: true, messages: [{ role: "user", content: "summary" }] };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

function compact(overrides: Partial<AgentTurnRequest> = {}, chunks = 1) {
  const { compactContext, summaries } = compaction(chunks);
  return { sent: request({ operation: "compact", compactContext, ...overrides }), summaries };
}

function call(name: string, input: Record<string, unknown>, id: string): LLMToolCall {
  return { id, name, input };
}

function run(
  turns: ScriptedTurn[],
  options: Partial<ConstructorParameters<typeof NapAgentService>[0]> = {},
) {
  const provider = new ScriptedLLMProvider(turns);
  return {
    provider,
    agent: new NapAgentService({ provider, retryDelayMs: 0, sidekickModel: SIDEKICK, ...options }),
  };
}

function models(provider: ScriptedLLMProvider): (string | undefined)[] {
  return provider.turnOptions.map((options) => options.model);
}

function payloads<T extends PendingEvent["type"]>(type: T): unknown[] {
  return events.filter((event) => event.type === type).map((event) => event.payload);
}

/** A provider whose sidekick turns are `sidekick`, and whose lead turns are scripted. */
function routed(lead: ScriptedLLMProvider, sidekick: () => LLMTurn): LLMProvider {
  return {
    startTurn: (options = {}) =>
      options.model === SIDEKICK ? sidekick() : lead.startTurn(options),
  };
}

/**
 * A sidekick that never answers and ignores being abandoned, as a stalled transport can. Only the
 * agent's own race can stop waiting on it, and only the signal it was handed can tell it to stop.
 */
function stalled(onRequest: (sent: LLMRequest) => void = () => {}): LLMTurn {
  return {
    complete: (sent) => {
      onRequest(sent);
      return new Promise(() => {});
    },
    usage: () => ({ inputTokens: 0, outputTokens: 0 }),
  };
}

/** What the loop allows a request's output when the context budget is large: its cap. */
const HEADROOM = 8_192;
/** The context budget an automatic compaction is tested under; a fifth of it exceeds HEADROOM. */
const CONTEXT_BUDGET = 50_000;
/** What one summary request is estimated to cost, input and output. */
const SUMMARY_COST =
  estimateContextTokens(SUMMARY_REQUEST) + (SUMMARY_REQUEST.maxOutputTokens ?? 0);

/** A normal turn that compacts automatically before its first step, as a long session's does. */
function automatic(compactContext: CompactContext): AgentTurnRequest {
  const base = request();
  return request({
    compactContext,
    context: { ...base.context, budgetTokens: CONTEXT_BUDGET, needsCompaction: true },
  });
}

/** What the turn estimates its next request at, from the context usage it reports first. */
async function nextRequestEstimate(): Promise<number> {
  const { agent } = run([[{ text: "the lead's summary" }, { text: "done" }]], {
    sidekickModel: undefined,
  });
  await agent.runTurn(automatic(compaction().compactContext));
  const reported = events.find((event) => event.type === "context.usage");
  events = [];
  if (reported?.type !== "context.usage") throw new Error("no context usage was reported");
  return reported.payload.inputTokens;
}

describe("who does the condensing", () => {
  it("runs explore helpers on the sidekick and general helpers on the lead", async () => {
    const { agent, provider } = run([
      [
        {
          toolCalls: [
            call("run_subagent", { profile: "explore", task: "Find the routes." }, "look"),
            call("run_subagent", { profile: "general", task: "Rename a route." }, "build"),
          ],
        },
        { text: "done" },
      ],
      [{ text: "src/App.tsx:1", usage: { inputTokens: 40, outputTokens: 4 } }],
      [{ text: "renamed", usage: { inputTokens: 50, outputTokens: 5 } }],
    ]);

    await agent.runTurn(request());

    expect(models(provider)).toEqual([LEAD, SIDEKICK, LEAD]);
    expect(payloads("turn.completed")).toEqual([
      expect.objectContaining({ usage: { inputTokens: 90, outputTokens: 9 } }),
    ]);
  });

  it("asks the sidekick for a compaction summary, and the lead is never asked", async () => {
    const { agent, provider } = run([
      // The lead's script is empty: a request reaching it throws, and the turn fails.
      [],
      [{ text: "the summary", usage: { inputTokens: 300, outputTokens: 30 } }],
    ]);
    const { sent, summaries } = compact();

    await agent.runTurn(sent);

    expect(models(provider)).toEqual([LEAD, SIDEKICK]);
    expect(provider.requests).toEqual([expect.objectContaining({ purpose: "compaction" })]);
    expect(summaries).toEqual([expect.objectContaining({ text: "the summary" })]);
    expect(payloads("turn.completed")).toEqual([
      expect.objectContaining({ usage: { inputTokens: 300, outputTokens: 30 } }),
    ]);
  });

  it("runs everything on the lead when the person's own key pays", async () => {
    const { agent, provider } = run([
      [
        { toolCalls: [call("run_subagent", { profile: "explore", task: "Look." }, "look")] },
        { text: "done" },
      ],
      [{ text: "found" }],
    ]);

    await agent.runTurn(request({ credentials: { platform: "anthropic", apiKey: "k" } }));

    expect(models(provider)).toEqual([LEAD, LEAD]);

    const own = run([[{ text: "the summary" }]]);
    await own.agent.runTurn(compact({ credentials: { platform: "anthropic", apiKey: "k" } }).sent);
    expect(models(own.provider)).toEqual([LEAD]);
    expect(own.provider.requests).toEqual([expect.objectContaining({ purpose: "compaction" })]);
  });

  it("has no sidekick when it would be the turn's own model", async () => {
    const { agent, provider } = run([[{ text: "the summary" }]]);

    await agent.runTurn(compact({ model: SIDEKICK }).sent);

    expect(models(provider)).toEqual([SIDEKICK]);
    expect(payloads("turn.completed")).toHaveLength(1);
  });

  it("has no sidekick when the lead is free, where it could only add cost", async () => {
    // The second turn would succeed whoever runs it, so a sidekick asked here would show.
    const { agent, provider } = run([
      [
        { toolCalls: [call("run_subagent", { profile: "explore", task: "Look." }, "look")] },
        { text: "done" },
      ],
      [{ text: "found" }],
    ]);

    await agent.runTurn(request({ model: FREE_LEAD }));

    expect(models(provider)).toEqual([FREE_LEAD, FREE_LEAD]);

    const free = run([[{ text: "the lead's summary" }], [{ text: "the sidekick's summary" }]]);
    const { sent, summaries } = compact({ model: FREE_LEAD });
    await free.agent.runTurn(sent);
    expect(models(free.provider)).toEqual([FREE_LEAD]);
    expect(summaries).toEqual([expect.objectContaining({ text: "the lead's summary" })]);
  });

  it("sends the lead the same first request with Fusion on as with it off", async () => {
    // The tool block and system prompt head every cached prefix (ADR-0024); Fusion must not
    // touch a byte of what the lead is sent.
    const on = run([[{ text: "done" }]]);
    await on.agent.runTurn(request());
    const off = run([[{ text: "done" }]], { sidekickModel: undefined });
    await off.agent.runTurn(request());

    const cached = (sent: LLMRequest | undefined) => ({
      tools: sent?.tools,
      systemPrompt: sent?.systemPrompt,
      messages: sent?.messages,
    });
    expect(on.provider.requests).toHaveLength(1);
    expect(off.provider.requests).toHaveLength(1);
    expect(cached(on.provider.requests[0])).toEqual(cached(off.provider.requests[0]));
  });
});

describe("a sidekick that fails leaves the work to the lead", () => {
  it.each([
    ["refuses", { refusal: true }],
    ["errors", { error: { message: "upstream", retryable: false } }],
    ["is cut off", { text: "half a summ", truncated: true }],
    ["calls a tool", { text: "a summary", toolCalls: [call("read_file", { path: APP }, "x")] }],
    ["says nothing", { text: "  " }],
  ] satisfies [string, ScriptedResponse][])(
    "when it %s, the lead summarizes the same request",
    async (_, failure) => {
      const { agent, provider } = run([
        [{ text: "the lead's summary", usage: { inputTokens: 200, outputTokens: 20 } }],
        [{ ...failure, usage: { inputTokens: 100, outputTokens: 10 } }],
      ]);
      const { sent, summaries } = compact();

      await agent.runTurn(sent);

      expect(models(provider)).toEqual([LEAD, SIDEKICK]);
      expect(provider.requests.map((sentRequest) => sentRequest.messages)).toEqual([
        SUMMARY_REQUEST.messages,
        SUMMARY_REQUEST.messages,
      ]);
      // What the compaction reports spending includes the attempt that failed.
      expect(summaries).toEqual([
        expect.objectContaining({
          text: "the lead's summary",
          usage: { inputTokens: 300, outputTokens: 30 },
        }),
      ]);
      expect(payloads("turn.completed")).toEqual([
        expect.objectContaining({ usage: { inputTokens: 300, outputTokens: 30 } }),
      ]);
    },
  );

  it("when it throws, the lead summarizes and the spend is marked incomplete", async () => {
    // An empty script throws on the first request, as a transport failure would.
    const { agent, provider } = run([[{ text: "the lead's summary" }], []]);
    const { sent, summaries } = compact();

    await agent.runTurn(sent);

    expect(models(provider)).toEqual([LEAD, SIDEKICK]);
    expect(summaries).toEqual([expect.objectContaining({ text: "the lead's summary" })]);
    expect(payloads("turn.completed")).toEqual([
      expect.objectContaining({ usageIncomplete: true }),
    ]);
  });

  it("stops asking the sidekick for the rest of the turn, without spending a step on it", async () => {
    // Two steps for two summary requests: a failed sidekick attempt is part of the step its
    // request already took, so the second request still has its own.
    const { agent, provider } = run(
      // The sidekick could answer the second request; once it has failed, it is not asked.
      [
        [{ text: "first" }, { text: "second" }],
        [{ refusal: true }, { text: "not asked" }],
      ],
      { budget: { maxSteps: 2 } },
    );
    const { sent, summaries } = compact({}, 2);

    await agent.runTurn(sent);

    expect(provider.requests).toHaveLength(3);
    expect(summaries.map((summary) => summary.type === "message" && summary.text)).toEqual([
      "first",
      "second",
    ]);
    expect(payloads("turn.completed")).toHaveLength(1);
  });

  it("gives up on a sidekick that takes too long, and waits on it only once", async () => {
    const lead = new ScriptedLLMProvider([[{ text: "first" }, { text: "second" }]]);
    const received: (AbortSignal | undefined)[] = [];
    const agent = new NapAgentService({
      provider: routed(lead, () => stalled((sent) => received.push(sent.signal))),
      sidekickModel: SIDEKICK,
      sidekickTimeoutMs: 5,
    });
    // With a turn signal, as every turn the runtime runs has, so the deadline joins it.
    const { sent, summaries } = compact({ signal: new AbortController().signal }, 2);

    await agent.runTurn(sent);

    expect(received).toHaveLength(1);
    // The abandoned request was told so, which is what stops a transport billing for it.
    expect(received[0]?.aborted).toBe(true);
    expect(summaries.map((summary) => summary.type === "message" && summary.text)).toEqual([
      "first",
      "second",
    ]);
    expect(payloads("turn.completed")).toEqual([
      expect.objectContaining({ usageIncomplete: true }),
    ]);
  });

  it("does not hand a cancelled turn's summary to the lead", async () => {
    // Scripted to answer, so a request that reached the lead would be recorded rather than thrown.
    const lead = new ScriptedLLMProvider([[{ text: "the lead's summary" }]]);
    const controller = new AbortController();
    const agent = new NapAgentService({
      provider: routed(lead, () => stalled(() => controller.abort())),
      sidekickModel: SIDEKICK,
    });

    await agent.runTurn(compact({ signal: controller.signal }).sent);

    expect(lead.requests).toEqual([]);
    expect(payloads("turn.failed")).toEqual([expect.objectContaining({ reason: "cancelled" })]);
  });

  it("when its conversation cannot even be opened, the lead summarizes", async () => {
    const lead = new ScriptedLLMProvider([[{ text: "the lead's summary" }]]);
    const agent = new NapAgentService({
      provider: routed(lead, () => {
        throw new Error("no such model");
      }),
      sidekickModel: SIDEKICK,
    });
    const { sent, summaries } = compact();

    await agent.runTurn(sent);

    expect(summaries).toEqual([expect.objectContaining({ text: "the lead's summary" })]);
    expect(payloads("turn.completed")).toHaveLength(1);
  });

  it("goes straight to the lead when the budget could not also cover the lead repeating it", async () => {
    // Enough for one summary request (100 out plus a small input), not for two.
    const { agent, provider } = run([[{ text: "the lead's summary" }]], {
      budget: { maxTokens: 180 },
    });

    await agent.runTurn(compact().sent);

    expect(models(provider)).toEqual([LEAD]);
    expect(payloads("turn.completed")).toHaveLength(1);
  });

  it("goes straight to the lead when the sidekick's window cannot hold the request", async () => {
    const lead = new ScriptedLLMProvider([[{ text: "the lead's summary" }]]);
    let asked = 0;
    const agent = new NapAgentService({
      provider: routed(lead, () => ({ ...stalled(() => asked++), contextWindowTokens: 50 })),
      sidekickModel: SIDEKICK,
    });

    await agent.runTurn(compact().sent);

    expect(asked).toBe(0);
    expect(payloads("turn.completed")).toHaveLength(1);
  });
});

describe("an automatic compaction inside a turn", () => {
  it.each([
    ["has room for", 0, "the sidekick's summary", [LEAD, SIDEKICK]],
    ["is a token short of", -1, "the lead's summary", [LEAD]],
  ])(
    "asks the sidekick only when the budget %s its attempt, the lead's repeat, the reserve and the lead's next request",
    async (_, slack, writer, asked) => {
      const next = await nextRequestEstimate();
      // The sidekick would succeed: a short budget is the only reason it is not asked.
      const { agent, provider } = run(
        [[{ text: "the lead's summary" }, { text: "done" }], [{ text: "the sidekick's summary" }]],
        { budget: { maxTokens: SUMMARY_COST * 2 + 4_096 + next + HEADROOM + slack } },
      );
      const { compactContext, summaries } = compaction();

      await agent.runTurn(automatic(compactContext));

      expect(models(provider)).toEqual(asked);
      expect(summaries).toEqual([expect.objectContaining({ text: writer })]);
      // The lead carries on from the summary, whoever wrote it.
      expect(provider.requests.map((sent) => sent.purpose)).toEqual(["compaction", undefined]);
      expect(payloads("turn.completed")).toHaveLength(1);
    },
  );
});

describe("the sidekick spends the turn's budget", () => {
  it("counts every sidekick token against the turn's ceiling", async () => {
    const { agent } = run(
      [[], [{ text: "a summary", usage: { inputTokens: 900, outputTokens: 0 } }]],
      {
        budget: { maxTokens: 1_000 },
      },
    );

    await agent.runTurn(compact().sent);
    expect(payloads("turn.completed")).toHaveLength(1);

    events = [];
    const over = run(
      [[], [{ text: "a summary", usage: { inputTokens: 1_001, outputTokens: 0 } }]],
      { budget: { maxTokens: 1_000 } },
    );
    await over.agent.runTurn(compact().sent);
    // A manual compaction that overran fails as the compaction it was, naming the ceiling.
    expect(payloads("turn.completed")).toEqual([]);
    expect(payloads("turn.failed")).toEqual([
      expect.objectContaining({ message: "token budget exceeded: 1001 tokens spent, limit 1000" }),
    ]);
  });

  it("counts a failed attempt's tokens too, so one that overspends fails the turn", async () => {
    // The lead would succeed; only the refused attempt's tokens can take the turn over.
    const { agent } = run(
      [
        [{ text: "the lead's summary" }],
        [{ refusal: true, usage: { inputTokens: 1_001, outputTokens: 0 } }],
      ],
      { budget: { maxTokens: 1_000 } },
    );

    await agent.runTurn(compact().sent);

    expect(payloads("turn.completed")).toEqual([]);
    expect(payloads("turn.failed")).toEqual([
      expect.objectContaining({ message: "token budget exceeded: 1001 tokens spent, limit 1000" }),
    ]);
  });

  it("writes only events the contract already parses", async () => {
    const { agent } = run([
      [
        { toolCalls: [call("run_subagent", { profile: "explore", task: "Look." }, "look")] },
        { text: "done" },
      ],
      [{ refusal: true }],
    ]);

    await agent.runTurn(request());

    expect(payloads("turn.completed")).toHaveLength(1);
    for (const [seq, event] of events.entries())
      expect(NapEventSchema.safeParse({ ...event, seq }).success).toBe(true);
  });
});
