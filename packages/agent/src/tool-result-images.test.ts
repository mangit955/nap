import type { LLMRequest } from "@nap/shared/ports/llm-provider";
import { describe, expect, it } from "vitest";
import { toRequestParams } from "./claude-provider.ts";
import { ScriptedLLMProvider } from "./testing/scripted-llm-provider.ts";

function request(): LLMRequest {
  return {
    systemPrompt: "Build the app",
    tools: [],
    messages: [
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "screen", name: "computer", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolCallId: "screen",
            isError: false,
            content: [
              { type: "text", text: "Desktop at 1024×768" },
              { type: "image", mediaType: "image/jpeg", data: "/9j/AAAA" },
            ],
          },
        ],
      },
    ],
  };
}

describe("image tool results", () => {
  it("maps text and images inside the answering block without changing tool pairing", () => {
    expect(toRequestParams(request()).messages).toEqual([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "screen", name: "computer", input: {} }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "screen",
            is_error: false,
            content: [
              { type: "text", text: "Desktop at 1024×768" },
              {
                type: "image",
                source: { type: "base64", media_type: "image/jpeg", data: "/9j/AAAA" },
              },
            ],
            cache_control: { type: "ephemeral" },
          },
        ],
      },
    ]);
  });

  it("records what the fake model actually received before later pruning mutates a request", async () => {
    const provider = new ScriptedLLMProvider([[{}]]);
    const input = request();
    const expected = structuredClone(input.messages);
    const turn = provider.startTurn();
    await turn.complete(input);
    const last = input.messages.at(-1);
    if (Array.isArray(last?.content)) {
      const result = last.content[0];
      if (result?.type === "tool_result") result.content = "Screenshot omitted";
    }
    expect(provider.requests[0]?.messages).toEqual(expected);
    expect(turn.requests[0]?.messages).toEqual(expected);
  });
});
