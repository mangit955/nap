import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import type { LLMProvider, LLMRequest, LLMTurnResult } from "@nap/shared/ports/llm-provider";
import { describe, expect, it } from "vitest";
import { CALIBRATION } from "./calibration.ts";
import { slowLLMProvider, slowSandboxManager } from "./slow-ports.ts";

/** Records what it was asked to wait for, rather than actually waiting. */
function recordingSleep() {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms: number) => {
      waits.push(ms);
    },
  };
}

const REQUEST: LLMRequest = { systemPrompt: "", messages: [], tools: [] };

function stubProvider(result: LLMTurnResult): LLMProvider {
  return {
    startTurn: () => ({
      complete: async () => result,
      usage: () => ({ inputTokens: 0, outputTokens: 0 }),
    }),
  };
}

const ANSWER: LLMTurnResult = {
  type: "message",
  text: "done",
  toolCalls: [],
  usage: { inputTokens: 1, outputTokens: 1 },
};

describe("slowSandboxManager", () => {
  it("makes a cold start take what a cold start took", async () => {
    const clock = recordingSleep();
    const sandbox = slowSandboxManager(new InMemorySandboxManager(), { sleep: clock.sleep });

    const created = await sandbox.create("project");

    expect(created.ok).toBe(true);
    expect(clock.waits).toEqual([CALIBRATION.sandboxCreateMs]);
  });

  it("makes the preview take as long to render as it did", async () => {
    const clock = recordingSleep();
    const sandbox = slowSandboxManager(new InMemorySandboxManager({ serves: [5173] }), {
      sleep: clock.sleep,
    });
    const created = await sandbox.create("project");
    if (!created.ok) throw new Error("the fake refused to create a sandbox");
    clock.waits.length = 0;

    const preview = await sandbox.waitForPreview(created.value.id, 5173);

    expect(preview.ok).toBe(true);
    expect(clock.waits).toEqual([CALIBRATION.previewRenderMs]);
  });

  it("leaves the calls a real sandbox answers instantly alone", async () => {
    const clock = recordingSleep();
    const sandbox = slowSandboxManager(new InMemorySandboxManager(), { sleep: clock.sleep });
    const created = await sandbox.create("project");
    if (!created.ok) throw new Error("the fake refused to create a sandbox");
    clock.waits.length = 0;

    await sandbox.writeFile(created.value.id, "/home/user/app/a.ts", "x");
    await sandbox.readFile(created.value.id, "/home/user/app/a.ts");

    expect(clock.waits).toEqual([]);
  });

  it("still answers exactly what the underlying manager answered", async () => {
    const sandbox = slowSandboxManager(new InMemorySandboxManager(), { sleep: async () => {} });

    const missing = await sandbox.readFile("nope", "/a");

    expect(missing.ok).toBe(false);
  });
});

describe("slowLLMProvider", () => {
  it("spends the whole turn's time before the first answer, and nothing after it", async () => {
    const clock = recordingSleep();
    const provider = slowLLMProvider(stubProvider(ANSWER), {
      sleep: clock.sleep,
      random: () => 0,
    });

    const turn = provider.startTurn();
    await turn.complete(REQUEST);
    await turn.complete(REQUEST);

    expect(clock.waits).toEqual([CALIBRATION.turnMs.min]);
  });

  it("draws each turn's duration from the recorded range", async () => {
    const clock = recordingSleep();
    const draws = [0, 1];
    const provider = slowLLMProvider(stubProvider(ANSWER), {
      sleep: clock.sleep,
      random: () => draws.shift() ?? 0,
    });

    await provider.startTurn().complete(REQUEST);
    await provider.startTurn().complete(REQUEST);

    expect(clock.waits).toEqual([CALIBRATION.turnMs.min, CALIBRATION.turnMs.max]);
  });

  it("hands back the underlying provider's result and usage untouched", async () => {
    const provider = slowLLMProvider(stubProvider(ANSWER), { sleep: async () => {} });

    const turn = provider.startTurn();

    expect(await turn.complete(REQUEST)).toEqual(ANSWER);
    expect(turn.usage()).toEqual({ inputTokens: 0, outputTokens: 0 });
  });
});
