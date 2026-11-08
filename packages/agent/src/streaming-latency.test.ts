import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import type { AgentTurnRequest } from "@nap/shared/ports/agent-service";
import type { PendingEvent } from "@nap/shared/ports/event-store";
import type {
  LLMProvider,
  LLMRequest,
  LLMTurn,
  LLMTurnResult,
} from "@nap/shared/ports/llm-provider";
import { beforeEach, describe, expect, it } from "vitest";
import { NapAgentService } from "./agent-service.ts";
import { FLUSH_AFTER_CHARS, FLUSH_AFTER_MS } from "./delta-stream.ts";
import { ManualScheduler } from "./testing/manual-scheduler.ts";
import { PROJECT_ROOT } from "./tools/definitions.ts";

/**
 * How soon what the model writes reaches the log while the model is still writing.
 *
 * The scripted provider cannot ask this: it delivers every delta and then returns, inside one
 * synchronous run, so a buffer that only flushed when the call returned looks the same as one
 * that flushed on time. Here each model call is a function the test steps through — a
 * preamble, then a pause standing in for a tool call's arguments streaming (which are not
 * text, so nothing is pushed), then the result — with the flush window on a scheduler the
 * test moves by hand.
 *
 * Asserted on event types and their order, never on wording.
 */

const SESSION_ID = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";
const TURN_ID = "7c9b1a52-8d3e-4f21-a0c4-1b2d3e4f5a6b";
const NO_USAGE = { inputTokens: 0, outputTokens: 0 };
const PREAMBLE = "Let me build the board.";

type Step = (request: LLMRequest) => Promise<LLMTurnResult>;

/** A provider whose every call is a function the test wrote, run in order. */
class SteppedProvider implements LLMProvider {
  readonly #steps: Step[];
  constructor(steps: Step[]) {
    this.#steps = steps;
  }
  startTurn(): LLMTurn {
    return {
      complete: (request) => {
        const step = this.#steps.shift();
        if (step === undefined) throw new Error("SteppedProvider: no step left");
        return step(request);
      },
      usage: () => NO_USAGE,
    };
  }
}

/** A promise the test resolves when it chooses — the model finishing its tool call. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

const writeBoard: LLMTurnResult = {
  type: "message",
  text: PREAMBLE,
  toolCalls: [
    {
      id: "toolu_board",
      name: "write_file",
      input: { path: `${PROJECT_ROOT}/src/Board.tsx`, contents: "export const Board = 1;\n" },
    },
  ],
  usage: NO_USAGE,
};
const done: Step = async (request) => {
  request.onTextDelta?.("Done.");
  return { type: "message", text: "Done.", toolCalls: [], usage: NO_USAGE };
};

let manager: InMemorySandboxManager;
let sandboxId: string;
let events: PendingEvent[];
let timers: ManualScheduler;

beforeEach(async () => {
  manager = new InMemorySandboxManager();
  const created = await manager.create("project");
  if (!created.ok) throw new Error(created.error.message);
  sandboxId = created.value.id;
  events = [];
  timers = new ManualScheduler();
});

function run(steps: Step[], overrides: Partial<AgentTurnRequest> = {}): Promise<void> {
  const agent = new NapAgentService({
    provider: new SteppedProvider(steps),
    schedule: timers.schedule,
  });
  return agent.runTurn({
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    sandboxId,
    sandbox: manager,
    context: {
      systemPrompt: "You are editing a React project.",
      messages: [{ role: "user", content: "Build a kanban board." }],
      estimatedTokens: 42,
    },
    onEvent: (event) => events.push(event),
    ...overrides,
  });
}

const types = () => events.map((event) => event.type);

/** Lets every promise already settled run its continuation. */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("prose streamed ahead of a tool call", () => {
  it("is shown once its window closes, while the model is still writing the tool call", async () => {
    const toolCall = gate();
    let calling = false;
    const finished = run([
      async (request) => {
        request.onTextDelta?.(PREAMBLE);
        calling = true;
        await toolCall.wait;
        return writeBoard;
      },
      done,
    ]);
    await settle();
    expect(calling).toBe(true);
    expect(types()).not.toContain("agent.message");

    timers.advance(FLUSH_AFTER_MS);

    // The call has not returned — this is the preamble arriving on time, not at the end.
    expect(types()).toEqual(["turn.started", "agent.message"]);

    toolCall.open();
    await finished;
    const order = types();
    expect(order.filter((type) => type === "agent.message")).toHaveLength(2);
    expect(order.indexOf("agent.message")).toBeLessThan(order.indexOf("tool.call"));
    expect(order.at(-1)).toBe("turn.completed");
    expect(timers.pending).toBe(0);
  });

  it("is shown the moment a tool call starts streaming, without waiting for the window", async () => {
    const toolCall = gate();
    let atToolStart: string[] = [];
    const finished = run([
      async (request) => {
        request.onTextDelta?.(PREAMBLE);
        request.onToolCallStart?.();
        atToolStart = types();
        await toolCall.wait;
        return writeBoard;
      },
      done,
    ]);
    await settle();

    expect(atToolStart).toEqual(["turn.started", "agent.message"]);
    expect(timers.pending).toBe(0);

    toolCall.open();
    await finished;
    // Flushed early, so not flushed again at the end of the call.
    expect(types().filter((type) => type === "agent.message")).toHaveLength(2);
  });

  it("keeps reasoning and prose in the order the model wrote them", async () => {
    // Two buffers, flushed independently: a short thought would otherwise sit in its own
    // buffer while a long reply crossed the character threshold in the other, and the log
    // would say the model answered before it thought.
    await run([
      async (request) => {
        request.onThinkingDelta?.("Checking the board.");
        request.onTextDelta?.("x".repeat(FLUSH_AFTER_CHARS + 10));
        request.onThinkingDelta?.("And the columns.");
        return { type: "message", text: "", toolCalls: [], usage: NO_USAGE };
      },
    ]);

    expect(types()).toEqual([
      "turn.started",
      "agent.thinking",
      "agent.message",
      "agent.thinking",
      "turn.completed",
    ]);
  });

  it("hands over a tail below both thresholds before the turn completes", async () => {
    await run([done]);

    expect(types()).toEqual(["turn.started", "agent.message", "turn.completed"]);
    expect(timers.pending).toBe(0);
  });
});

describe("a step that does not end normally", () => {
  it("writes nothing after a cancelled turn's ending, however late the transport delivers", async () => {
    const controller = new AbortController();
    let late: ((text: string) => void) | undefined;
    const finished = run(
      [
        async (request) => {
          request.onTextDelta?.("Half a sen");
          late = request.onTextDelta;
          controller.abort();
          // A transport tearing down can take a while to honour the signal.
          await new Promise(() => {});
          return writeBoard;
        },
      ],
      { signal: controller.signal },
    );
    await finished;
    expect(timers.pending).toBe(0);

    late?.("tence, and then a great deal more that the model had already sent.");
    late?.("y".repeat(FLUSH_AFTER_CHARS));
    timers.advance(FLUSH_AFTER_MS * 4);

    expect(types()).toEqual(["turn.started", "turn.failed"]);
    expect(timers.pending).toBe(0);
  });

  it("leaves no window armed when the provider throws", async () => {
    const finished = run([
      async (request) => {
        request.onTextDelta?.("Partial");
        throw new Error("the provider broke");
      },
    ]);

    await expect(finished).rejects.toThrow("the provider broke");
    expect(timers.pending).toBe(0);
    const before = types();
    timers.advance(FLUSH_AFTER_MS * 4);
    expect(types()).toEqual(before);
  });

  it("keeps the reasoning of a call that failed, ahead of the failure", async () => {
    await run([
      async (request) => {
        request.onThinkingDelta?.("Trying the board.");
        return { type: "error", message: "bad request", retryable: false, usage: NO_USAGE };
      },
    ]);

    expect(types()).toEqual(["turn.started", "agent.thinking", "turn.failed"]);
    expect(timers.pending).toBe(0);
  });
});
