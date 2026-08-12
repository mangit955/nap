import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { NapEventSchema, type NapEventType } from "@nap/shared/events";
import type { AgentTurnRequest } from "@nap/shared/ports/agent-service";
import type { BuiltContext } from "@nap/shared/ports/context-engine";
import type { PendingEvent } from "@nap/shared/ports/event-store";
import type { LLMMessage, LLMToolCall } from "@nap/shared/ports/llm-provider";
import { beforeEach, describe, expect, it } from "vitest";
import { NapAgentService } from "./agent-service.ts";
import { ScriptedLLMProvider, type ScriptedTurn } from "./testing/scripted-llm-provider.ts";
import { PROJECT_ROOT, TOOL_DEFINITIONS } from "./tools/definitions.ts";

/**
 * What a turn did, asserted through its events and its traffic — never through prose.
 *
 * The model's wording is not a contract (docs/PLAN.md §3), so every assertion here is on
 * an event type, an ordering, a tool-call sequence, or the shape of what reached the
 * provider. The last of those matters more than it looks: the rule that a round trip's
 * tool results travel in one user message is invisible in the event stream, and breaking
 * it produces a slower agent rather than an error.
 */

const SESSION_ID = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";
const TURN_ID = "7c9b1a52-8d3e-4f21-a0c4-1b2d3e4f5a6b";
const APP = `${PROJECT_ROOT}/src/App.tsx`;

class Recorder {
  readonly events: PendingEvent[] = [];
  /** Runs on every event, so a test can act at a point mid-turn. */
  onEach?: (event: PendingEvent) => void;

  readonly emit = (event: PendingEvent): void => {
    this.events.push(event);
    this.onEach?.(event);
  };

  get types(): NapEventType[] {
    return this.events.map((event) => event.type);
  }

  payloadsOf<T extends NapEventType>(type: T): unknown[] {
    return this.events.filter((event) => event.type === type).map((event) => event.payload);
  }
}

let manager: InMemorySandboxManager;
let sandboxId: string;
let recorder: Recorder;

beforeEach(async () => {
  manager = new InMemorySandboxManager();
  const created = await manager.create("project");
  if (!created.ok) throw new Error(created.error.message);
  sandboxId = created.value.id;
  recorder = new Recorder();
});

const CONTEXT: BuiltContext = {
  systemPrompt: "You are editing a React project.",
  messages: [{ role: "user", content: "What does App.tsx render?" }],
  estimatedTokens: 42,
};

function request(overrides: Partial<AgentTurnRequest> = {}): AgentTurnRequest {
  return {
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    sandboxId,
    context: CONTEXT,
    sandbox: manager,
    onEvent: recorder.emit,
    ...overrides,
  };
}

function call(name: string, input: Record<string, unknown>, id: string): LLMToolCall {
  return { id, name, input };
}

function service(turns: ScriptedTurn[], budget?: { maxSteps?: number; maxTokens?: number }) {
  const provider = new ScriptedLLMProvider(turns);
  return {
    provider,
    agent: new NapAgentService(budget === undefined ? { provider } : { provider, budget }),
  };
}

/** The blocks of the last message sent to the model — where tool results end up. */
function lastMessage(messages: readonly LLMMessage[]): LLMMessage {
  const last = messages[messages.length - 1];
  if (last === undefined) throw new Error("no messages were sent");
  return last;
}

describe("runTurn — event ordering", () => {
  it("emits started, call, result, message, completed in exactly that order", async () => {
    await manager.writeFile(
      sandboxId,
      APP,
      "export default function App() {\n  return <h1/>;\n}\n",
    );
    const { agent } = service([
      [{ toolCalls: [call("read_file", { path: APP }, "toolu_1")] }, { text: "A heading." }],
    ]);

    await agent.runTurn(request());

    expect(recorder.types).toEqual([
      "turn.started",
      "tool.call",
      "tool.result",
      "agent.message",
      "turn.completed",
    ]);
  });

  it("executes several tools in the order the model asked for them", async () => {
    await manager.writeFile(sandboxId, APP, "x\n");
    const { agent } = service([
      [
        {
          toolCalls: [
            call("read_file", { path: APP }, "toolu_a"),
            call("list_files", { path: PROJECT_ROOT }, "toolu_b"),
            call("write_file", { path: `${PROJECT_ROOT}/n.ts`, contents: "y\n" }, "toolu_c"),
          ],
        },
        { text: "Done." },
      ],
    ]);

    await agent.runTurn(request());

    expect(recorder.payloadsOf("tool.call")).toEqual([
      expect.objectContaining({ toolCallId: "toolu_a" }),
      expect.objectContaining({ toolCallId: "toolu_b" }),
      expect.objectContaining({ toolCallId: "toolu_c" }),
    ]);
    expect(recorder.payloadsOf("tool.result")).toEqual([
      expect.objectContaining({ toolCallId: "toolu_a" }),
      expect.objectContaining({ toolCallId: "toolu_b" }),
      expect.objectContaining({ toolCallId: "toolu_c" }),
    ]);
  });

  it("produces events that are all valid once a seq is added", async () => {
    await manager.writeFile(sandboxId, APP, "x\n");
    const { agent } = service([
      [{ toolCalls: [call("read_file", { path: APP }, "toolu_1")] }, { text: "ok" }],
    ]);

    await agent.runTurn(request());

    for (const [index, event] of recorder.events.entries()) {
      expect(NapEventSchema.safeParse({ ...event, seq: index }).success).toBe(true);
    }
  });
});

describe("runTurn — talking to the model", () => {
  it("declares the six proxy tools as the entire tool set", async () => {
    const { agent, provider } = service([[{ text: "Nothing to do." }]]);

    await agent.runTurn(request());

    expect(provider.requests[0]?.tools).toEqual(TOOL_DEFINITIONS);
    expect(provider.requests[0]?.systemPrompt).toBe(CONTEXT.systemPrompt);
  });

  it("sends every tool result of a round trip in one user message", async () => {
    // Parallel tool use is on by default, and splitting the answers across several user
    // messages is accepted by the API while quietly training the model out of asking for
    // tools in parallel. The failure is a slower agent, never an error — so it needs a test.
    await manager.writeFile(sandboxId, APP, "x\n");
    const { agent, provider } = service([
      [
        {
          toolCalls: [
            call("read_file", { path: APP }, "toolu_a"),
            call("read_file", { path: `${PROJECT_ROOT}/missing.ts` }, "toolu_b"),
            call("list_files", { path: PROJECT_ROOT }, "toolu_c"),
          ],
        },
        { text: "Done." },
      ],
    ]);

    await agent.runTurn(request());

    const second = provider.requests[1];
    if (second === undefined) throw new Error("the model was not called a second time");

    // One assistant message and one user message were added — not one user message per tool.
    expect(second.messages).toHaveLength(CONTEXT.messages.length + 2);

    const results = lastMessage(second.messages);
    expect(results.role).toBe("user");
    expect(results.content).toEqual([
      expect.objectContaining({ type: "tool_result", toolCallId: "toolu_a", isError: false }),
      // The failure travels with the rest. A dropped block is a 400, not a smaller request.
      expect.objectContaining({ type: "tool_result", toolCallId: "toolu_b", isError: true }),
      expect.objectContaining({ type: "tool_result", toolCallId: "toolu_c", isError: false }),
    ]);
  });

  it("echoes the model's tool calls back as an assistant message", async () => {
    // A tool_use block with no answering tool_result is rejected, and so is the reverse.
    await manager.writeFile(sandboxId, APP, "x\n");
    const { agent, provider } = service([
      [{ toolCalls: [call("read_file", { path: APP }, "toolu_1")] }, { text: "ok" }],
    ]);

    await agent.runTurn(request());

    const assistant = provider.requests[1]?.messages[CONTEXT.messages.length];
    expect(assistant?.role).toBe("assistant");
    expect(assistant?.content).toEqual([
      expect.objectContaining({ type: "tool_use", id: "toolu_1", name: "read_file" }),
    ]);
  });
});

describe("runTurn — failure branches", () => {
  it("feeds a tool error back to the model instead of aborting", async () => {
    const { agent } = service([
      [
        { toolCalls: [call("read_file", { path: `${PROJECT_ROOT}/missing.ts` }, "toolu_1")] },
        { text: "I will create it." },
      ],
    ]);

    await agent.runTurn(request());

    expect(recorder.payloadsOf("tool.result")).toEqual([expect.objectContaining({ ok: false })]);
    // The turn survived the failing tool and ran to completion.
    expect(recorder.types).toContain("turn.completed");
    expect(recorder.types).not.toContain("turn.failed");
  });

  it("fails the turn on a refusal", async () => {
    const { agent } = service([[{ refusal: true }]]);

    await agent.runTurn(request());

    expect(recorder.types).toEqual(["turn.started", "turn.failed"]);
    expect(recorder.payloadsOf("turn.failed")).toEqual([
      expect.objectContaining({ reason: "refusal" }),
    ]);
  });

  it("fails the turn when the provider gives up", async () => {
    // Retries are the provider's business and are already spent by the time one of these
    // arrives, so there is nothing left for the loop to do but stop.
    const { agent } = service([[{ error: { message: "529 overloaded", retryable: true } }]]);

    await agent.runTurn(request());

    expect(recorder.payloadsOf("turn.failed")).toEqual([
      expect.objectContaining({ reason: "internal" }),
    ]);
  });

  it("stops tool execution when cancelled mid-turn", async () => {
    manager.script(/first/, { stdout: "1\n" });
    manager.script(/second/, { stdout: "2\n" });
    const controller = new AbortController();
    // Cancel the moment the first tool reports back, so the second is still pending.
    recorder.onEach = (event) => {
      if (event.type === "tool.result") controller.abort();
    };
    const { agent } = service([
      [
        {
          toolCalls: [
            call("run_command", { command: "first" }, "toolu_a"),
            call("run_command", { command: "second" }, "toolu_b"),
          ],
        },
      ],
    ]);

    await agent.runTurn(request({ signal: controller.signal }));

    expect(recorder.payloadsOf("turn.failed")).toEqual([
      expect.objectContaining({ reason: "cancelled" }),
    ]);
    // The second tool never reached the sandbox — cancellation stopped execution rather
    // than running the command and discarding what it returned.
    expect(manager.commands(sandboxId)).toHaveLength(1);
    expect(recorder.payloadsOf("tool.call")).toHaveLength(1);
  });

  it("fails the turn before calling the model when already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    const { agent, provider } = service([[{ text: "never asked" }]]);

    await agent.runTurn(request({ signal: controller.signal }));

    expect(provider.requests).toHaveLength(0);
    expect(recorder.payloadsOf("turn.failed")).toEqual([
      expect.objectContaining({ reason: "cancelled" }),
    ]);
  });

  it("fails the turn when the step budget runs out", async () => {
    await manager.writeFile(sandboxId, APP, "x\n");
    const { agent } = service([[{ toolCalls: [call("read_file", { path: APP }, "toolu_1")] }]], {
      maxSteps: 1,
    });

    await agent.runTurn(request());

    expect(recorder.payloadsOf("turn.failed")).toEqual([
      expect.objectContaining({ reason: "budget_exceeded" }),
    ]);
    expect(recorder.types).not.toContain("turn.completed");
  });
});

describe("runTurn — completion", () => {
  it("reports the commit the caller made", async () => {
    const { agent } = service([[{ text: "Done." }]]);

    await agent.runTurn(request({ finalize: async () => ({ commitSha: "9f1c0aa" }) }));

    expect(recorder.payloadsOf("turn.completed")).toEqual([
      expect.objectContaining({ commitSha: "9f1c0aa" }),
    ]);
  });

  it("completes with no commit when the caller does not version the workspace", async () => {
    const { agent } = service([[{ text: "Done." }]]);

    await agent.runTurn(request());

    expect(recorder.payloadsOf("turn.completed")).toEqual([
      expect.objectContaining({ commitSha: null }),
    ]);
  });

  it("finalizes before reporting completion", async () => {
    // The other order would publish a turn as done while its changes were still uncommitted.
    const order: string[] = [];
    recorder.onEach = (event) => order.push(event.type);
    const { agent } = service([[{ text: "Done." }]]);

    await agent.runTurn(
      request({
        finalize: async () => {
          order.push("finalize");
          return { commitSha: "abc1234" };
        },
      }),
    );

    expect(order).toEqual(["turn.started", "agent.message", "finalize", "turn.completed"]);
  });

  it("reports what the whole turn cost, not just the last call", async () => {
    await manager.writeFile(sandboxId, APP, "x\n");
    const { agent } = service([
      [
        {
          toolCalls: [call("read_file", { path: APP }, "toolu_1")],
          usage: { inputTokens: 100, outputTokens: 20 },
        },
        { text: "ok", usage: { inputTokens: 300, outputTokens: 40 } },
      ],
    ]);

    await agent.runTurn(request());

    expect(recorder.payloadsOf("turn.completed")).toEqual([
      expect.objectContaining({ usage: { inputTokens: 400, outputTokens: 60 } }),
    ]);
  });
});

describe("runTurn — the model thinking out loud", () => {
  it("emits the reasoning before the step it explains", async () => {
    const { agent } = service([
      [
        { thinking: ["I should read App.tsx"], toolCalls: [call("list_files", {}, "toolu_1")] },
        { thinking: ["Now I can answer"], text: "A heading." },
      ],
    ]);

    await agent.runTurn(request());

    // Reasoning leads its step in both round trips. A turn whose thinking arrived after the
    // tool call it motivated would read as an explanation of the wrong thing.
    expect(recorder.types).toEqual([
      "turn.started",
      "agent.thinking",
      "tool.call",
      "tool.result",
      "agent.thinking",
      "agent.message",
      "turn.completed",
    ]);
  });

  it("coalesces a burst of deltas rather than emitting one event each", async () => {
    const { agent } = service([[{ thinking: ["Read ", "the ", "file"], text: "done" }]]);

    await agent.runTurn(request());

    expect(recorder.payloadsOf("agent.thinking")).toEqual([{ text: "Read the file" }]);
  });

  it("emits nothing for a step that did no thinking", async () => {
    const { agent } = service([[{ text: "done" }]]);

    await agent.runTurn(request());

    expect(recorder.types).not.toContain("agent.thinking");
  });

  it("keeps the reasoning of a turn that then failed", async () => {
    // The thinking is the only account of what the model was doing when it stopped, and it
    // is most worth having on the path where nothing else explains the turn.
    const { agent } = service([[{ thinking: ["Considering the request"], refusal: true }]]);

    await agent.runTurn(request());

    expect(recorder.types).toEqual(["turn.started", "agent.thinking", "turn.failed"]);
  });

  it("keeps the reasoning of a turn the provider could not complete", async () => {
    const { agent } = service([
      [{ thinking: ["Starting"], error: { message: "upstream is down", retryable: false } }],
    ]);

    await agent.runTurn(request());

    expect(recorder.types).toEqual(["turn.started", "agent.thinking", "turn.failed"]);
  });

  it("carries the session and turn a step's other events carry", async () => {
    const { agent } = service([[{ thinking: ["a thought"], text: "done" }]]);

    await agent.runTurn(request());

    const thinking = recorder.events.find((event) => event.type === "agent.thinking");
    expect(thinking).toMatchObject({ sessionId: SESSION_ID, turnId: TURN_ID });
    // Through the schema, so this is a real event rather than an object shaped like one.
    expect(() => NapEventSchema.parse({ ...thinking, seq: 1 })).not.toThrow();
  });
});

describe("runTurn — the model writing its answer", () => {
  /** Long enough to cross the coalescer's threshold, so streaming is observable at all. */
  const LONG = "I added the button and wired it to the toggle handler in App.tsx. ".repeat(4);
  const pieces = (): string[] =>
    recorder.payloadsOf("agent.message").map((payload) => (payload as { text: string }).text);

  it("emits the prose in pieces as it is written", async () => {
    // The point of streaming is that the reader sees the answer before it is finished. For a
    // short reply that is invisible — the pieces coalesce into one event either way — so the
    // assertion needs prose long enough to arrive in more than one.
    const { agent } = service([[{ streamedText: [...LONG], text: LONG }]]);

    await agent.runTurn(request());

    expect(pieces().length).toBeGreaterThan(1);
    expect(pieces().join("")).toBe(LONG);
  });

  it("does not repeat the assembled answer after streaming it", async () => {
    // The assembled response carries the same words the deltas did. Emitting both would put
    // the whole answer on the rail twice, once in pieces and once whole.
    const { agent } = service([[{ streamedText: [...LONG], text: LONG }]]);

    await agent.runTurn(request());

    expect(pieces().join("")).toBe(LONG);
  });

  it("falls back to the assembled answer when nothing was streamed", async () => {
    // Not every model or route sends text deltas. Saying nothing at all in that case would
    // trade a lump of prose for no prose.
    const { agent } = service([[{ text: "I added the button." }]]);

    await agent.runTurn(request());

    expect(pieces()).toEqual(["I added the button."]);
  });

  it("keeps the prose ahead of the tool call it introduces", async () => {
    const { agent } = service([
      [
        {
          thinking: ["I need to write a file"],
          streamedText: ["Adding ", "the component."],
          text: "Adding the component.",
          toolCalls: [call("list_files", {}, "toolu_1")],
        },
        { streamedText: ["Done."], text: "Done." },
      ],
    ]);

    await agent.runTurn(request());

    expect(recorder.types).toEqual([
      "turn.started",
      "agent.thinking",
      "agent.message",
      "tool.call",
      "tool.result",
      "agent.message",
      "turn.completed",
    ]);
  });

  it("says nothing for a step that wrote no prose at all", async () => {
    const { agent } = service([
      [{ toolCalls: [call("list_files", {}, "toolu_1")] }, { text: "done" }],
    ]);

    await agent.runTurn(request());

    expect(recorder.types).toEqual([
      "turn.started",
      "tool.call",
      "tool.result",
      "agent.message",
      "turn.completed",
    ]);
  });
});
