import { RateLimitError } from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { type AnthropicClient, type AnthropicMessage, ClaudeProvider } from "./claude-provider.ts";
import { countRequests } from "./counted-client.ts";

const ANSWER = {
  content: [{ type: "text", text: "done", citations: null }],
  stop_reason: "end_turn",
  usage: {
    input_tokens: 10,
    output_tokens: 2,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
  },
} as AnthropicMessage;

/** Throttled `failures` times, then answers. */
function throttledClient(failures: number): AnthropicClient {
  let calls = 0;
  return {
    messages: {
      stream() {
        calls += 1;
        const throttled = calls <= failures;
        return {
          on() {},
          finalMessage: async () => {
            if (throttled) throw new RateLimitError(429, undefined, "slow down", new Headers());
            return ANSWER;
          },
        };
      },
    },
  };
}

describe("countRequests", () => {
  it("counts every attempt the provider makes, not one per model call", async () => {
    const counted = countRequests(throttledClient(2));
    const provider = new ClaudeProvider({ client: counted.client, sleep: async () => {} });

    const result = await provider
      .startTurn()
      .complete({ systemPrompt: "s", messages: [{ role: "user", content: "hi" }], tools: [] });

    expect(result.type).toBe("message");
    expect(counted.requests()).toBe(3);
  });
});
