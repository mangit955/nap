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

import type Anthropic from "@anthropic-ai/sdk";
import type { LLMRequest } from "@nap/shared/ports/llm-provider";
import { expect, it } from "vitest";
import { type AnthropicClient, type AnthropicMessage, ClaudeProvider } from "./claude-provider.ts";
import { createOpenRouterClient, toOpenRouterModel } from "./openrouter.ts";

if (!process.env.OPENROUTER_API_KEY) {
  throw new Error(
    "OPENROUTER_API_KEY is not set, so nothing here can observe a cache hit. Put it in " +
      "apps/api/.env, then re-run. This file costs a fraction of a cent.",
  );
}

/**
 * Pinned to Claude rather than to whatever `NAP_MODEL` currently is, because *this* is the
 * claim being tested: explicit `cache_control` breakpoints, whose minimum prefix and 5-minute
 * TTL are Anthropic's semantics. Other vendors cache automatically and by their own rules, so
 * pointing this at one would leave the breakpoints unexercised and still pass.
 *
 * Sonnet 5 specifically: the *stricter* minimum of the two Claude models we run — 1024 tokens
 * against Opus 5's 512 — so a prefix that caches here caches on both.
 */
const MODEL = "claude-sonnet-5";
const MINIMUM_CACHEABLE_TOKENS = 1024;

/**
 * Through OpenRouter, which is the only route configured.
 *
 * Worth running this way in its own right: OpenRouter's caching documentation describes usage
 * in OpenAI's shape (`prompt_tokens_details.cached_tokens`). If that shape reaches us here,
 * `toTokenUsage` reads zero for every cached token and `TurnBudget` silently under-counts — so
 * the two assertions below are the check for that, not just for the breakpoints.
 */
function sdk(): Anthropic {
  return createOpenRouterClient();
}

const REQUEST_MODEL = toOpenRouterModel(MODEL);

/**
 * Long enough to clear the minimum on its own, and fixed so both calls share it byte for byte.
 *
 * Deliberately not the real `SYSTEM_PROMPT`: this test is about the caching mechanism, and
 * pinning it to a prompt another task is free to edit would make it fail for unrelated reasons.
 * What the real prompt measures is the second test.
 */
const SYSTEM = [
  // Unique per run, and load-bearing. A cache entry survives ~5 minutes, so re-running this
  // file inside the TTL finds the prefix already warm: nothing is *written*, and the assertion
  // that a write happened fails against code that is working perfectly. Salting the prefix
  // makes every run start cold, which is the only state in which "wrote, then read" is a
  // statement about the code rather than about how recently someone last ran it.
  `Session ${crypto.randomUUID()}.`,
  ...Array.from(
    { length: 120 },
    (_, i) =>
      `Rule ${i + 1}: keep the change small, explain the reason, and never invent a file path.`,
  ),
].join("\n");

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

it("caches the real prompt, not just a synthetic one long enough to qualify", async () => {
  // The test above proves the mechanism with a prefix built to clear the minimum comfortably.
  // This one asks the question that actually decides whether any of it pays off in production:
  // does *our* prompt — the real contract plus the real tool schemas — clear it?
  //
  // Asked empirically rather than by counting. The obvious version calls `messages.countTokens`
  // and compares against the documented minimum, and it is worse in two ways: OpenRouter does
  // not implement that endpoint (it 404s), and a token count only supports an inference about
  // caching. A non-zero cache counter *is* the thing being claimed. Our local 4-chars-per-token
  // rule estimated this prefix at ~1188 against a 1024 minimum, which is far too thin a margin
  // to trust to an estimate.
  const { SYSTEM_PROMPT } = await import("@nap/context/system-prompt");
  const { TOOL_DEFINITIONS } = await import("./tools/definitions.ts");

  const client = recordingClient();
  const provider = new ClaudeProvider({
    client,
    model: REQUEST_MODEL,
    effort: "low",
    maxTokens: 64,
  });

  const result = await provider.startTurn().complete({
    systemPrompt: SYSTEM_PROMPT,
    messages: [{ role: "user", content: "Reply with the single word ok." }],
    tools: TOOL_DEFINITIONS,
  });
  expect(result.type).toBe("message");

  const [response] = client.responses;
  if (response === undefined) throw new Error("expected a response");

  const written = response.usage.cache_creation_input_tokens ?? 0;
  const read = response.usage.cache_read_input_tokens ?? 0;
  console.log(`real prefix: ${JSON.stringify(response.usage)}`);

  // Either counter proves the prefix qualified. Which one it is depends on whether an earlier
  // run left the entry warm, and asserting on a specific one would make this fail on a rerun
  // within the TTL — a green-then-red test that tracks the clock rather than the code.
  expect(written + read).toBeGreaterThan(0);
  expect(written + read).toBeGreaterThanOrEqual(MINIMUM_CACHEABLE_TOKENS);
});
