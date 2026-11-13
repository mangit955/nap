/**
 * That a turn full of screenshots re-reads its conversation from the cache, and re-writes it only
 * where old screenshots are cut.
 *
 * `cache-prefix.test.ts` proves the request bytes: across a run of computer steps, what one
 * request sent opens the next byte for byte except at the batch cuts. What it cannot prove is how
 * the API prices that — whether a conversation of nested JPEG tool results caches at all on this
 * route, whether the entry each request writes is the one the next reads, and what a cut costs.
 * Those are claims about the provider, so they need its counters.
 *
 * The conversation is built the way the agent loop builds it: each step appends a `computer` call
 * and a result carrying a real 1024×768 screenshot, then prunes with the loop's own function, and
 * the request goes through `ClaudeProvider`. The model's replies are ignored; only `usage` is read.
 * The turn's message carries the context engine's settled-history marker, as a real turn's does.
 *
 * What is asserted: every request that cut nothing read everything the request before it sent,
 * and every request that cut read less than that. If the API repriced more than the cut — say it
 * treated a removed image as invalidating every cached message — the cut requests still pass and
 * the counters printed below show by how much, which is the number worth looking at.
 *
 * Costs about fifteen cents on Sonnet 5: eleven requests, each a few thousand tokens and at most
 * six screenshots of about a thousand each, with replies capped at 64 tokens. Run it alone:
 *   bunx vitest run --project integration packages/agent/src/screenshot-caching.integration.test.ts
 */

import { readFileSync } from "node:fs";
import type Anthropic from "@anthropic-ai/sdk";
import {
  COMPUTER_IMAGES_HIGH_WATER,
  COMPUTER_IMAGES_KEPT,
  countComputerImages,
  pruneComputerImagesInBatches,
} from "@nap/shared/computer-context";
import type { LLMMessage } from "@nap/shared/ports/llm-provider";
import { expect, it } from "vitest";
import { type AnthropicClient, type AnthropicMessage, ClaudeProvider } from "./claude-provider.ts";
import { createOpenRouterClient, toOpenRouterModel } from "./openrouter.ts";
import { toolsetFor } from "./tools/toolset.ts";

if (!process.env.OPENROUTER_API_KEY) {
  throw new Error(
    "OPENROUTER_API_KEY is not set, so nothing here can observe a cache hit. Put it in " +
      "apps/api/.env, then re-run. This file costs about fifteen cents.",
  );
}

/** Claude, for the reason `prompt-caching.integration.test.ts` gives: the breakpoints are its. */
const MODEL = toOpenRouterModel("claude-sonnet-5");

/** Two cuts: the step that passes the mark, and the one after the gap has refilled. */
const STEPS =
  COMPUTER_IMAGES_HIGH_WATER + (COMPUTER_IMAGES_HIGH_WATER - COMPUTER_IMAGES_KEPT + 1) + 1;

const SCREENSHOT = readFileSync(
  new URL("../../../docs/research/computer-chrome-linux/positive/before.jpg", import.meta.url),
).toString("base64");

/** Salted so every run starts cold: a warm prefix from an earlier run would read on request 0. */
const SYSTEM = [
  `Session ${crypto.randomUUID()}.`,
  ...Array.from(
    { length: 120 },
    (_, i) => `Rule ${i + 1}: look at the screen before acting, and say what changed after.`,
  ),
].join("\n");

const TOOLS = toolsetFor({
  promptSource: "user",
  family: "claude",
  computer: true,
  subagents: false,
});

function step(i: number): LLMMessage[] {
  return [
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: `screen_${i}`,
          name: "computer",
          input: { actions: [{ action: "screenshot" }] },
        },
      ],
    },
    {
      role: "user",
      content: [
        {
          type: "tool_result",
          toolCallId: `screen_${i}`,
          isError: false,
          content: [
            { type: "text", text: `Completed 1 computer action. Screenshot 1024×768 (${i}).` },
            { type: "image", mediaType: "image/jpeg", data: SCREENSHOT },
          ],
        },
      ],
    },
  ];
}

function recordingClient(): AnthropicClient & { responses: AnthropicMessage[] } {
  const client: Anthropic = createOpenRouterClient();
  const responses: AnthropicMessage[] = [];
  return {
    responses,
    messages: {
      stream(body, options) {
        const stream = client.messages.stream(body, options);
        return {
          on: (event, listener) => {
            stream.on(event, listener);
          },
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

it("reads each request's conversation back on the next, and re-writes it only at a cut", async () => {
  const client = recordingClient();
  const provider = new ClaudeProvider({ client, model: MODEL, effort: "low", maxTokens: 64 });
  const turn = provider.startTurn();

  let messages: LLMMessage[] = [
    { role: "user", content: "Check the page a few times.", cacheBreakpoint: true },
  ];
  const cuts: number[] = [];
  for (let i = 0; i < STEPS; i += 1) {
    const before = messages;
    messages = pruneComputerImagesInBatches([...messages, ...step(i)]);
    if (JSON.stringify(messages.slice(0, before.length)) !== JSON.stringify(before)) cuts.push(i);
    expect(countComputerImages(messages)).toBeLessThanOrEqual(COMPUTER_IMAGES_HIGH_WATER);
    // Sequential: an entry becomes readable only once the response that wrote it has begun.
    const result = await turn.complete({ systemPrompt: SYSTEM, messages, tools: TOOLS });
    if (result.type === "error") throw new Error(`request ${i} failed: ${result.message}`);
  }
  expect(cuts).toHaveLength(2);

  const usage = client.responses.map((response) => ({
    read: response.usage.cache_read_input_tokens ?? 0,
    written: response.usage.cache_creation_input_tokens ?? 0,
    uncached: response.usage.input_tokens,
  }));
  const total = usage.map((u) => u.read + u.written + u.uncached);
  console.table(usage.map((u, i) => ({ ...u, total: total[i], cut: cuts.includes(i) })));
  expect(usage).toHaveLength(STEPS);

  // The first request writes the instructions and the turn's start; nothing is warm yet.
  expect(usage[0]?.written ?? 0).toBeGreaterThan(0);
  for (let i = 1; i < STEPS; i += 1) {
    const previous = total[i - 1] ?? 0;
    const read = usage[i]?.read ?? 0;
    // A step that cut nothing appended one exchange; everything before it was the previous
    // request, and must come back from the cache. The tolerance is far below one screenshot.
    if (cuts.includes(i)) {
      expect(read, `request ${i} cut, so it cannot read all of request ${i - 1}`).toBeLessThan(
        previous,
      );
      // Still the instructions and the turn's start, which no cut touches.
      expect(read, `request ${i} read nothing at all`).toBeGreaterThan(0);
    } else {
      expect(read, `request ${i} should read all of request ${i - 1}`).toBeGreaterThanOrEqual(
        previous - 200,
      );
    }
  }
}, 300_000);
