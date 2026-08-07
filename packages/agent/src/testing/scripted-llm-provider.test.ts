import type { LLMRequest } from "@nap/shared/ports/llm-provider";
import { describe, expect, it } from "vitest";
import { ScriptedLLMProvider } from "./scripted-llm-provider.ts";

function request(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    systemPrompt: "you build apps",
    messages: [{ role: "user", content: "add a button" }],
    tools: [],
    ...overrides,
  };
}

describe("ScriptedLLMProvider", () => {
  it("emits a turn's scripted responses in order", async () => {
    const provider = new ScriptedLLMProvider([
      [
        { toolCalls: [{ id: "call-1", name: "write_file", input: { path: "a.tsx" } }] },
        { toolCalls: [{ id: "call-2", name: "read_file", input: { path: "a.tsx" } }] },
        { text: "done" },
      ],
    ]);

    const turn = provider.startTurn();
    const first = await turn.complete(request());
    const second = await turn.complete(request());
    const third = await turn.complete(request());

    expect(first).toMatchObject({ type: "message", toolCalls: [{ name: "write_file" }] });
    expect(second).toMatchObject({ type: "message", toolCalls: [{ name: "read_file" }] });
    expect(third).toMatchObject({ type: "message", text: "done", toolCalls: [] });
  });

  it("scripts refusals and errors, not just messages", async () => {
    const provider = new ScriptedLLMProvider([
      [{ refusal: true }],
      [{ error: { message: "overloaded", retryable: true } }],
    ]);

    expect(await provider.startTurn().complete(request())).toEqual({
      type: "refusal",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    expect(await provider.startTurn().complete(request())).toEqual({
      type: "error",
      message: "overloaded",
      retryable: true,
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  });

  it("accumulates usage within a turn and starts the next turn at zero", async () => {
    const provider = new ScriptedLLMProvider([
      [
        { text: "one", usage: { inputTokens: 100, outputTokens: 10 } },
        { text: "two", usage: { inputTokens: 250, outputTokens: 40 } },
      ],
      [{ text: "three", usage: { inputTokens: 7, outputTokens: 3 } }],
    ]);

    const first = provider.startTurn();
    expect(first.usage()).toEqual({ inputTokens: 0, outputTokens: 0 });
    await first.complete(request());
    expect(first.usage()).toEqual({ inputTokens: 100, outputTokens: 10 });
    await first.complete(request());
    expect(first.usage()).toEqual({ inputTokens: 350, outputTokens: 50 });

    const second = provider.startTurn();
    expect(second.usage()).toEqual({ inputTokens: 0, outputTokens: 0 });
    await second.complete(request());
    expect(second.usage()).toEqual({ inputTokens: 7, outputTokens: 3 });

    // The earlier turn's total is not disturbed by a later one.
    expect(first.usage()).toEqual({ inputTokens: 350, outputTokens: 50 });
  });

  it("records the requests it was given, so a caller can assert on what was sent", async () => {
    const provider = new ScriptedLLMProvider([[{ text: "ok" }, { text: "ok" }]]);
    const turn = provider.startTurn();

    const withTool = request({
      tools: [{ name: "read_file", description: "read", inputSchema: { type: "object" } }],
    });
    const withResult = request({
      messages: [
        { role: "user", content: "add a button" },
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "call-1", name: "read_file", input: {} }],
        },
        {
          role: "user",
          content: [
            { type: "tool_result", toolCallId: "call-1", content: "<html/>", isError: false },
          ],
        },
      ],
    });

    await turn.complete(withTool);
    await turn.complete(withResult);

    expect(turn.requests).toEqual([withTool, withResult]);
    expect(provider.requests).toEqual([withTool, withResult]);
  });

  it("throws when a turn's script runs out", async () => {
    const provider = new ScriptedLLMProvider([[{ text: "only one" }]]);
    const turn = provider.startTurn();
    await turn.complete(request());

    await expect(turn.complete(request())).rejects.toThrow(/script.*exhausted/i);
  });

  it("throws when more turns are started than were scripted", () => {
    const provider = new ScriptedLLMProvider([[{ text: "only one turn" }]]);
    provider.startTurn();

    expect(() => provider.startTurn()).toThrow(/turn/i);
  });
});
