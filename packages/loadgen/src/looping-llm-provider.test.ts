import type { LLMRequest } from "@nap/shared/ports/llm-provider";
import { describe, expect, it } from "vitest";
import { loopingLLMProvider } from "./looping-llm-provider.ts";

const request: LLMRequest = { systemPrompt: "", messages: [], tools: [] };

describe("loopingLLMProvider", () => {
  it("hands out the script in order within one turn", async () => {
    const provider = loopingLLMProvider([
      { text: "working", toolCalls: [{ id: "1", name: "write_file", input: { path: "a" } }] },
      { text: "done" },
    ]);
    const turn = provider.startTurn();

    const first = await turn.complete(request);
    expect(first.type === "message" && first.toolCalls).toHaveLength(1);
    const second = await turn.complete(request);
    expect(second.type === "message" && second.toolCalls).toEqual([]);
  });

  it("starts every turn at the beginning of the script, unboundedly", async () => {
    // The reason this exists at all: a load run does not know in advance how many turns it
    // will start, and a provider that throws past a fixed count fails the run rather than the
    // system under test.
    const provider = loopingLLMProvider([{ text: "done" }]);
    for (let i = 0; i < 500; i += 1) {
      const result = await provider.startTurn().complete(request);
      expect(result.type).toBe("message");
    }
  });

  it("repeats the last response rather than throwing when a turn runs long", async () => {
    // The last entry is a plain answer, so repeating it ends the agent's loop. Throwing would
    // fail a turn for a reason that is about the harness.
    const provider = loopingLLMProvider([{ text: "done" }]);
    const turn = provider.startTurn();
    await turn.complete(request);
    const again = await turn.complete(request);
    expect(again.type === "message" && again.text).toBe("done");
  });

  it("streams thinking and text before it answers", async () => {
    const provider = loopingLLMProvider([{ thinking: ["a"], streamedText: ["b"], text: "b" }]);
    const thinking: string[] = [];
    const text: string[] = [];
    await provider.startTurn().complete({
      ...request,
      onThinkingDelta: (delta) => thinking.push(delta),
      onTextDelta: (delta) => text.push(delta),
    });
    expect(thinking).toEqual(["a"]);
    expect(text).toEqual(["b"]);
  });

  it("accumulates the turn's usage across its calls", async () => {
    const provider = loopingLLMProvider([
      { text: "a", usage: { inputTokens: 100, outputTokens: 10 } },
      { text: "b", usage: { inputTokens: 200, outputTokens: 20 } },
    ]);
    const turn = provider.startTurn();
    await turn.complete(request);
    await turn.complete(request);
    expect(turn.usage()).toEqual({ inputTokens: 300, outputTokens: 30 });
  });

  it("refuses an empty script rather than answering nothing forever", () => {
    expect(() => loopingLLMProvider([])).toThrow(RangeError);
  });
});
