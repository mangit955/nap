import type Anthropic from "@anthropic-ai/sdk";
import { APIConnectionError, BadRequestError, RateLimitError } from "@anthropic-ai/sdk";
import type { LLMRequest } from "@nap/shared/ports/llm-provider";
import { describe, expect, it, vi } from "vitest";
import {
  type AnthropicClient,
  type AnthropicMessage,
  ClaudeProvider,
  MAX_ATTEMPTS,
} from "./claude-provider.ts";

/**
 * A stub standing in for the SDK. Everything the provider does to a response goes
 * through here, so failure paths are drivable without a network or `vi.mock`.
 */
function stubClient(
  responses: (AnthropicMessage | Error)[],
): AnthropicClient & { calls: { body: unknown; options: unknown }[] } {
  const calls: { body: unknown; options: unknown }[] = [];
  let index = 0;

  return {
    calls,
    messages: {
      stream(body, options) {
        calls.push({ body, options });
        const next = responses[index];
        index += 1;
        if (next === undefined) throw new Error(`stub has no response for call ${index}`);
        return {
          finalMessage: async () => {
            if (next instanceof Error) throw next;
            return next;
          },
        };
      },
    },
  };
}

function message(overrides: Partial<AnthropicMessage> = {}): AnthropicMessage {
  return {
    content: [{ type: "text", text: "hello", citations: null }],
    stop_reason: "end_turn",
    usage: {
      input_tokens: 10,
      output_tokens: 4,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    },
    ...overrides,
  } as AnthropicMessage;
}

function rateLimited(): RateLimitError {
  return new RateLimitError(429, undefined, "slow down", new Headers());
}

function request(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    systemPrompt: "you build apps",
    messages: [{ role: "user", content: "add a button" }],
    tools: [],
    ...overrides,
  };
}

/** No real waiting: the retry policy's timing is not what these tests are about. */
const noSleep = () => Promise.resolve();

function provider(client: AnthropicClient) {
  return new ClaudeProvider({ client, sleep: noSleep });
}

describe("ClaudeProvider", () => {
  describe("usage accounting", () => {
    it("accumulates across the calls of one turn and starts a new turn at zero", async () => {
      const client = stubClient([
        message({ usage: usage(100, 10) }),
        message({ usage: usage(250, 40) }),
        message({ usage: usage(7, 3) }),
      ]);
      const claude = provider(client);

      const first = claude.startTurn();
      expect(first.usage()).toEqual({ inputTokens: 0, outputTokens: 0 });
      await first.complete(request());
      await first.complete(request());
      expect(first.usage()).toEqual({ inputTokens: 350, outputTokens: 50 });

      const second = claude.startTurn();
      expect(second.usage()).toEqual({ inputTokens: 0, outputTokens: 0 });
      await second.complete(request());
      expect(second.usage()).toEqual({ inputTokens: 7, outputTokens: 3 });
      expect(first.usage()).toEqual({ inputTokens: 350, outputTokens: 50 });
    });

    it("counts cached input tokens, which the API reports separately from input_tokens", async () => {
      // `input_tokens` is the uncached remainder only. Ignoring the cache fields would
      // under-report a cached turn's real input by most of its size, and the budget in
      // docs/PLAN.md §4 is built on these numbers.
      const client = stubClient([
        message({
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_creation_input_tokens: 200,
            cache_read_input_tokens: 3_000,
          } as AnthropicMessage["usage"],
        }),
      ]);

      const turn = provider(client).startTurn();
      await turn.complete(request());

      expect(turn.usage()).toEqual({ inputTokens: 3_210, outputTokens: 5 });
    });

    it("still counts a call that ended in an error", async () => {
      const client = stubClient([new BadRequestError(400, undefined, "bad", new Headers())]);
      const turn = provider(client).startTurn();

      const result = await turn.complete(request());

      expect(result.type).toBe("error");
      expect(turn.usage()).toEqual({ inputTokens: 0, outputTokens: 0 });
    });
  });

  describe("refusals", () => {
    it("returns a typed refusal without ever reading content", async () => {
      // The point of the refusal branch is that a caller cannot reach for text that is
      // not there. A throwing getter makes that structural rather than a convention:
      // if the mapper ever indexes content on this path, this test fails loudly.
      const refused = {
        stop_reason: "refusal",
        stop_details: { type: "refusal", category: "cyber", explanation: null },
        usage: usage(12, 0),
        get content(): never {
          throw new Error("content must not be read on a refusal");
        },
      } as unknown as AnthropicMessage;

      const turn = provider(stubClient([refused])).startTurn();
      const result = await turn.complete(request());

      expect(result).toEqual({ type: "refusal", usage: { inputTokens: 12, outputTokens: 0 } });
    });
  });

  describe("retry policy", () => {
    it("retries a 429 and returns the successful result", async () => {
      const client = stubClient([rateLimited(), message({ usage: usage(5, 2) })]);

      const result = await provider(client).startTurn().complete(request());

      expect(result).toMatchObject({ type: "message", text: "hello" });
      expect(client.calls).toHaveLength(2);
    });

    it("gives up after N attempts and reports the failure as retryable", async () => {
      const client = stubClient(Array.from({ length: MAX_ATTEMPTS }, () => rateLimited()));

      const result = await provider(client).startTurn().complete(request());

      expect(result).toMatchObject({ type: "error", retryable: true });
      expect(client.calls).toHaveLength(MAX_ATTEMPTS);
    });

    it("retries a dropped connection", async () => {
      const client = stubClient([new APIConnectionError({ message: "socket hang up" }), message()]);

      const result = await provider(client).startTurn().complete(request());

      expect(result.type).toBe("message");
      expect(client.calls).toHaveLength(2);
    });

    it("does not retry a request the server rejected as malformed", async () => {
      const client = stubClient([new BadRequestError(400, undefined, "bad tools", new Headers())]);

      const result = await provider(client).startTurn().complete(request());

      expect(result).toMatchObject({ type: "error", retryable: false });
      expect(client.calls).toHaveLength(1);
    });

    it("backs off between attempts rather than hammering", async () => {
      const sleep = vi.fn((_ms: number) => Promise.resolve());
      const client = stubClient([rateLimited(), rateLimited(), message()]);

      await new ClaudeProvider({ client, sleep }).startTurn().complete(request());

      expect(sleep).toHaveBeenCalledTimes(2);
      const first = sleep.mock.calls[0]?.[0] ?? 0;
      const second = sleep.mock.calls[1]?.[0] ?? 0;
      expect(second).toBeGreaterThan(first);
    });
  });

  describe("request mapping", () => {
    it("sends the model, effort and thinking configuration this project standardised on", async () => {
      const client = stubClient([message()]);

      await provider(client).startTurn().complete(request());

      const body = client.calls[0]?.body as Anthropic.MessageStreamParams;
      expect(body.model).toBe("claude-opus-5");
      expect(body.output_config).toEqual({ effort: "xhigh" });
      expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
      // A block array rather than a string, because the prompt carries a cache breakpoint —
      // the text itself is asserted under "prompt caching" below.
      expect(body.system).toMatchObject([{ type: "text", text: "you build apps" }]);
    });

    it("can be pointed at a cheaper model and a lower effort without changing anything else", async () => {
      // Development turns are spent debugging the loop rather than judging its answers, and
      // the two models are structurally identical — same blocks, same streaming, same refusal
      // semantics. Anything that is not a model or an effort must be unaffected.
      const client = stubClient([message()]);

      await new ClaudeProvider({ client, model: "claude-sonnet-5", effort: "low" })
        .startTurn()
        .complete(request());

      const body = client.calls[0]?.body as Anthropic.MessageStreamParams;
      expect(body.model).toBe("claude-sonnet-5");
      expect(body.output_config).toEqual({ effort: "low" });
      expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
    });

    it("can be given a smaller output ceiling, so a run cannot spend more than intended", async () => {
      const client = stubClient([message()]);

      await new ClaudeProvider({ client, maxTokens: 4096 }).startTurn().complete(request());

      const body = client.calls[0]?.body as Anthropic.MessageStreamParams;
      expect(body.max_tokens).toBe(4096);
    });

    it("sends no sampling parameters, which this model rejects outright", async () => {
      const client = stubClient([message()]);

      await provider(client).startTurn().complete(request());

      const body = client.calls[0]?.body as Record<string, unknown>;
      expect(body).not.toHaveProperty("temperature");
      expect(body).not.toHaveProperty("top_p");
      expect(body).not.toHaveProperty("top_k");
      expect(body.thinking).not.toHaveProperty("budget_tokens");
    });

    it("declares tools in the shape the API expects", async () => {
      const client = stubClient([message()]);
      const schema = {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      };

      await provider(client)
        .startTurn()
        .complete(
          request({
            tools: [{ name: "read_file", description: "Read a file", inputSchema: schema }],
          }),
        );

      const body = client.calls[0]?.body as Anthropic.MessageStreamParams;
      expect(body.tools).toEqual([
        { name: "read_file", description: "Read a file", input_schema: schema },
      ]);
    });

    it("translates tool calls and their results back into API blocks", async () => {
      const client = stubClient([message()]);

      await provider(client)
        .startTurn()
        .complete(
          request({
            messages: [
              { role: "user", content: "add a button" },
              {
                role: "assistant",
                content: [
                  { type: "text", text: "reading it" },
                  { type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.tsx" } },
                ],
              },
              {
                role: "user",
                content: [
                  {
                    type: "tool_result",
                    toolCallId: "call-1",
                    content: "boom",
                    isError: true,
                  },
                ],
              },
            ],
          }),
        );

      const body = client.calls[0]?.body as Anthropic.MessageStreamParams;
      // `toMatchObject`, because the final block also carries a cache breakpoint — that is
      // asserted under "prompt caching" below rather than repeated here.
      expect(body.messages).toMatchObject([
        // String content is widened to a block so a breakpoint has somewhere to live.
        { role: "user", content: [{ type: "text", text: "add a button" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "reading it" },
            { type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.tsx" } },
          ],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "call-1", content: "boom", is_error: true },
          ],
        },
      ]);
    });

    it("forwards the abort signal to the call", async () => {
      const client = stubClient([message()]);
      const controller = new AbortController();

      await provider(client)
        .startTurn()
        .complete(request({ signal: controller.signal }));

      expect(client.calls[0]?.options).toMatchObject({ signal: controller.signal });
    });
  });

  describe("response mapping", () => {
    it("joins text blocks and collects tool calls", async () => {
      const client = stubClient([
        message({
          stop_reason: "tool_use",
          content: [
            { type: "text", text: "I will read it.", citations: null },
            { type: "tool_use", id: "call-1", name: "read_file", input: { path: "a.tsx" } },
            { type: "tool_use", id: "call-2", name: "list_files", input: { path: "." } },
          ],
        } as Partial<AnthropicMessage>),
      ]);

      const result = await provider(client).startTurn().complete(request());

      expect(result).toEqual({
        type: "message",
        text: "I will read it.",
        toolCalls: [
          { id: "call-1", name: "read_file", input: { path: "a.tsx" } },
          { id: "call-2", name: "list_files", input: { path: "." } },
        ],
        usage: { inputTokens: 10, outputTokens: 4 },
      });
    });

    it("ignores thinking blocks, which are not the turn's answer", async () => {
      const client = stubClient([
        message({
          content: [
            { type: "thinking", thinking: "let me consider", signature: "sig" },
            { type: "text", text: "the answer", citations: null },
          ],
        } as Partial<AnthropicMessage>),
      ]);

      const result = await provider(client).startTurn().complete(request());

      expect(result).toMatchObject({ type: "message", text: "the answer" });
    });
  });

  describe("prompt caching", () => {
    /**
     * These assert the *shape* of the request, which is all a test without a network can
     * honestly claim. Whether the cache actually hits is `usage.cache_read_input_tokens` on a
     * real call — see `prompt-caching.integration.test.ts`.
     */

    /** Every `cache_control` in a body, wherever it sits. The API allows at most four. */
    function breakpoints(body: Anthropic.MessageStreamParams): unknown[] {
      const found: unknown[] = [];
      const walk = (node: unknown): void => {
        if (Array.isArray(node)) return void node.forEach(walk);
        if (node === null || typeof node !== "object") return;
        for (const [key, value] of Object.entries(node)) {
          if (key === "cache_control" && value !== null && value !== undefined) found.push(value);
          else walk(value);
        }
      };
      walk(body.system);
      walk(body.messages);
      walk(body.tools);
      return found;
    }

    async function bodyOf(overrides: Partial<LLMRequest> = {}) {
      const client = stubClient([message()]);
      await provider(client).startTurn().complete(request(overrides));
      return client.calls[0]?.body as Anthropic.MessageStreamParams;
    }

    it("marks the system prompt, which caches the tools rendered before it too", async () => {
      const body = await bodyOf();

      // A block array rather than a bare string: a string has nowhere to hang the marker.
      expect(body.system).toEqual([
        { type: "text", text: "you build apps", cache_control: { type: "ephemeral" } },
      ]);
    });

    it("marks the last block of the last message, so the next step reads this one", async () => {
      const body = await bodyOf({
        messages: [
          { role: "user", content: "add a button" },
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "t1", name: "write_file", input: {} }],
          },
          {
            role: "user",
            content: [
              { type: "tool_result", toolCallId: "t1", content: "wrote it", isError: false },
            ],
          },
        ],
      });

      const [first, , last] = body.messages;
      expect(last?.content).toMatchObject([
        { type: "tool_result", cache_control: { type: "ephemeral" } },
      ]);
      // Only the last one. A marker left on an earlier turn would pin the cache to a prefix
      // that stops growing, and every later step would re-read the same stale point.
      expect(JSON.stringify(first)).not.toContain("cache_control");
    });

    it("converts string content to a block so the marker has somewhere to live", async () => {
      const body = await bodyOf({ messages: [{ role: "user", content: "add a button" }] });

      expect(body.messages[0]?.content).toEqual([
        { type: "text", text: "add a button", cache_control: { type: "ephemeral" } },
      ]);
    });

    it("moves the marker along as the conversation grows", async () => {
      const short = await bodyOf({ messages: [{ role: "user", content: "one" }] });
      const long = await bodyOf({
        messages: [
          { role: "user", content: "one" },
          { role: "assistant", content: "two" },
        ],
      });

      expect(JSON.stringify(short.messages[0])).toContain("cache_control");
      // The same first message is now unmarked — the breakpoint followed the conversation.
      expect(JSON.stringify(long.messages[0])).not.toContain("cache_control");
      expect(JSON.stringify(long.messages[1])).toContain("cache_control");
    });

    it("stays within the four breakpoints the API allows", async () => {
      const body = await bodyOf({
        messages: Array.from({ length: 12 }, (_, i) => ({
          role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
          content: `message ${i}`,
        })),
      });

      expect(breakpoints(body)).toHaveLength(2);
    });

    it("asks for no cache when there is no conversation to cache", async () => {
      // Not a real call shape, but it must not throw reaching for a block that isn't there.
      const body = await bodyOf({ messages: [] });

      expect(body.messages).toEqual([]);
      expect(breakpoints(body)).toHaveLength(1);
    });
  });
});

function usage(input: number, output: number): AnthropicMessage["usage"] {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
  } as AnthropicMessage["usage"];
}
