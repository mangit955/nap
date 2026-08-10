/**
 * That the cache actually hits.
 *
 * The unit tests assert where the `cache_control` markers land, which is all a stub can be
 * asked. Whether the API *honours* them is a different claim, and it fails silently: a prefix
 * below the model's minimum is not an error, it is a zero in `cache_creation_input_tokens` and
 * a bill that quietly stays at full price. The only check that distinguishes the two is
 * `usage.cache_read_input_tokens` coming back non-zero from a real call.
 *
 * **The minimum is per-model and not monotonic** — 512 tokens on `claude-opus-5`, 1024 on
 * `claude-sonnet-5`, 4096 on Opus 4.6 — so the margin is worth measuring rather than assuming.
 * This file prints the real prefix size next to the model's minimum; token counting is not
 * billed, so that part costs nothing.
 *
 * The request under test is the one `ClaudeProvider` builds, not a hand-written body — the
 * whole point is to prove *our* markers cache. That needs the raw response, which the provider
 * folds into a single total on the way out, so the client below keeps a copy on the way past.
 *
 * Its own file rather than an addition to `claude-provider.integration.test.ts`, so it can be
 * run alone for a fraction of a cent. Two short calls on Sonnet is the whole bill.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { LLMRequest } from "@nap/shared/ports/llm-provider";
import { expect, it } from "vitest";
import { type AnthropicClient, type AnthropicMessage, ClaudeProvider } from "./claude-provider.ts";
import { createOpenRouterClient, toOpenRouterModel } from "./openrouter.ts";

const VIA_OPENROUTER = !process.env.ANTHROPIC_API_KEY && Boolean(process.env.OPENROUTER_API_KEY);

if (!process.env.ANTHROPIC_API_KEY && !VIA_OPENROUTER) {
  throw new Error(
    "Neither ANTHROPIC_API_KEY nor OPENROUTER_API_KEY is set, so nothing here can observe a " +
      "cache hit. Put one in apps/api/.env, then re-run. This file costs a fraction of a cent.",
  );
}

/**
 * The cheap model, and the one with the *stricter* minimum of the two we run — 1024 tokens
 * against Opus 5's 512. A prefix that caches here caches on both.
 */
const MODEL = "claude-sonnet-5";
const MINIMUM_CACHEABLE_TOKENS = 1024;

/**
 * The same models either way; only the biller and the id format differ.
 *
 * OpenRouter is worth running this against in its own right: it serves Claude over a native
 * Anthropic Messages endpoint, but its own caching documentation describes usage in OpenAI's
 * shape (`prompt_tokens_details.cached_tokens`). If that shape reaches us here, `toTokenUsage`
 * reads zero for every cached token and `TurnBudget` silently under-counts — so the two
 * assertions below are the check for that, not just for the breakpoints.
 */
function sdk(): Anthropic {
  return VIA_OPENROUTER ? createOpenRouterClient() : new Anthropic();
}

const REQUEST_MODEL = VIA_OPENROUTER ? toOpenRouterModel(MODEL) : MODEL;

/**
 * Long enough to clear the minimum on its own, and fixed so both calls share it byte for byte.
 *
 * Deliberately not the real `SYSTEM_PROMPT`: this test is about the caching mechanism, and
 * pinning it to a prompt another task is free to edit would make it fail for unrelated reasons.
 * What the real prompt measures is the second test.
 */
const SYSTEM = Array.from(
  { length: 120 },
  (_, i) =>
    `Rule ${i + 1}: keep the change small, explain the reason, and never invent a file path.`,
).join("\n");

function request(userText: string): LLMRequest {
  return { systemPrompt: SYSTEM, messages: [{ role: "user", content: userText }], tools: [] };
}

/** The real SDK, with every assembled response kept so the cache counters stay readable. */
function recordingClient(): AnthropicClient & { responses: AnthropicMessage[] } {
  const client = sdk();
  const responses: AnthropicMessage[] = [];

  return {
    responses,
    messages: {
      stream(body, options) {
        const stream = client.messages.stream(body, options);
        return {
          finalMessage: async () => {
            const message = await stream.finalMessage();
            responses.push(message);
            return message;
          },
        };
      },
    },
  };
}

it("writes the prefix on the first call and reads it back on the second", async () => {
  const client = recordingClient();
  const provider = new ClaudeProvider({
    client,
    model: REQUEST_MODEL,
    effort: "low",
    // Short answers: the prefix is what this test is paying for, not the completion.
    maxTokens: 64,
  });

  // Sequential, not parallel. An entry becomes readable only once the first response has begun
  // streaming, so two concurrent calls would both pay full price and prove nothing.
  const turn = provider.startTurn();
  expect((await turn.complete(request("Say ok."))).type).toBe("message");
  expect((await turn.complete(request("Say ok again."))).type).toBe("message");

  const [first, second] = client.responses;
  if (first === undefined || second === undefined) throw new Error("expected two responses");

  console.log("first :", JSON.stringify(first.usage));
  console.log("second:", JSON.stringify(second.usage));

  // The write, then the read. Asserting only the second would pass against a prefix that was
  // already warm from an earlier run of this file, which is a different claim.
  expect(first.usage.cache_creation_input_tokens ?? 0).toBeGreaterThan(0);
  expect(second.usage.cache_read_input_tokens ?? 0).toBeGreaterThan(0);

  // And the saving is real: the second call's uncached remainder is a fraction of what it
  // would have re-sent. This is the number the whole change exists to move.
  expect(second.usage.input_tokens).toBeLessThan(second.usage.cache_read_input_tokens ?? 0);
});

it("measures the real prompt's margin over the minimum", async () => {
  // The number that decides whether any of this works in production. Measured rather than
  // estimated: our local ~4-chars-per-token rule put this at ~1188, uncomfortably close to
  // 1024, and Sonnet 5's tokenizer is not the one that rule was calibrated against.
  const { SYSTEM_PROMPT } = await import("@nap/context/system-prompt");
  const { TOOL_DEFINITIONS } = await import("./tools/definitions.ts");

  const counted = await sdk().messages.countTokens({
    model: REQUEST_MODEL,
    system: SYSTEM_PROMPT,
    tools: TOOL_DEFINITIONS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
    })),
    messages: [{ role: "user", content: "hi" }],
  });

  console.log(
    `real tools+system prefix: ${counted.input_tokens} tokens, ` +
      `${counted.input_tokens - MINIMUM_CACHEABLE_TOKENS} over the ${MODEL} minimum ` +
      `(via ${VIA_OPENROUTER ? "OpenRouter" : "Anthropic"})`,
  );
  expect(counted.input_tokens).toBeGreaterThan(MINIMUM_CACHEABLE_TOKENS);
});
