import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import type { CompactContext } from "@nap/shared/compaction";
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

/** A manual compaction whose summary is `chunks` requests, each checked as the runtime's is. */
function compaction(chunks = 1): { compactContext: CompactContext; summaries: LLMTurnResult[] } {
  const summaries: LLMTurnResult[] = [];
  return {
    summaries,
    // As the runtime's compactor does, a throw becomes a failed compaction, never an escape.
    compactContext: async (input) => {
      try {
        for (let chunk = 0; chunk < chunks; chunk += 1) {
          const result = await input.complete(SUMMARY_REQUEST);
          if (result.type !== "message" || result.text.trim() === "")
            return { ok: false, message: "no summary" };
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

/** A sidekick that never answers on its own, and says so the moment it is abandoned. */
function hanging(onRequest: () => void = () => {}): LLMTurn {
  return {
    complete: (sent) => {
      onRequest();
      return new Promise((_, reject) =>
        sent.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
      );
    },
    usage: () => ({ inputTokens: 0, outputTokens: 0 }),
  };
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
    expect(cached(on.provider.requests[0])).toEqual(cached(off.provider.requests[0]));
  });
});

describe("a sidekick that fails leaves the work to the lead", () => {
  it.each([
    ["refuses", { refusal: true }],
    ["errors", { error: { message: "upstream", retryable: false } }],
    ["is cut off", { text: "half a summ", truncated: true }],
    ["calls a tool", { toolCalls: [call("read_file", { path: APP }, "x")] }],
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
    let asked = 0;
    const agent = new NapAgentService({
      provider: routed(lead, () => hanging(() => asked++)),
      sidekickModel: SIDEKICK,
      sidekickTimeoutMs: 5,
    });
    const { sent, summaries } = compact({}, 2);

    await agent.runTurn(sent);

    expect(asked).toBe(1);
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
      provider: routed(lead, () => hanging(() => controller.abort())),
      sidekickModel: SIDEKICK,
    });

    await agent.runTurn(compact({ signal: controller.signal }).sent);

    expect(lead.requests).toEqual([]);
    expect(payloads("turn.failed")).toEqual([expect.objectContaining({ reason: "cancelled" })]);
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
      provider: routed(lead, () => ({ ...hanging(() => asked++), contextWindowTokens: 50 })),
      sidekickModel: SIDEKICK,
    });

    await agent.runTurn(compact().sent);

    expect(asked).toBe(0);
    expect(payloads("turn.completed")).toHaveLength(1);
  });
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
