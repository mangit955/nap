import type { NapEvent } from "@nap/shared/events";
import type { ContextRequest } from "@nap/shared/ports/context-engine";
import type { LLMContentBlock, LLMMessage } from "@nap/shared/ports/llm-provider";
import type { Memory, MemoryProvider } from "@nap/shared/ports/memory-provider";
import type { FileNode } from "@nap/shared/ports/sandbox-manager";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_BUDGET_TOKENS,
  ELIDED_TOOL_OUTPUT,
  MIN_BUDGET_TOKENS,
  NapContextEngine,
} from "./context-engine.ts";
import { NoopMemoryProvider } from "./noop-memory-provider.ts";
import { SYSTEM_PROMPT } from "./system-prompt.ts";
import { type FileTree, stubSandbox } from "./testing/stub-sandbox.ts";
import { estimateTokens } from "./tokens.ts";

const SESSION = "6f1c1d3e-2b7a-4c5e-8f9a-0d1e2f3a4b5c";
const SANDBOX = "sbx_1";
const ROOT = "/home/user/app";

// ---------------------------------------------------------------------------
// Event builders — `seq` is assigned in creation order, as the store would.
// ---------------------------------------------------------------------------

let nextSeq = 0;
function turnId(n: number): string {
  return `1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c${String(n).padStart(2, "0")}`;
}

function event<T extends NapEvent["type"]>(
  type: T,
  turn: number,
  payload: Extract<NapEvent, { type: T }>["payload"],
): NapEvent {
  nextSeq += 1;
  return {
    type,
    sessionId: SESSION,
    turnId: turnId(turn),
    seq: nextSeq,
    createdAt: "2026-08-07T12:00:00.000Z",
    payload,
  } as NapEvent;
}

const userMessage = (turn: number, text: string) => event("user.message", turn, { text });
const agentMessage = (turn: number, text: string) => event("agent.message", turn, { text });
const thinking = (turn: number, text: string) => event("agent.thinking", turn, { text });

const toolCall = (turn: number, id: string, input: Record<string, unknown> = {}) =>
  event("tool.call", turn, { toolCallId: id, toolName: "read_file", input });

const toolResult = (turn: number, id: string, output: string, ok = true) =>
  event("tool.result", turn, { toolCallId: id, toolName: "read_file", ok, output });

/** A turn made of prose alone, so it can only be reclaimed by dropping the whole turn. */
function wordyTurn(turn: number, size: number): NapEvent[] {
  return [userMessage(turn, `change number ${turn}`), agentMessage(turn, "w".repeat(size))];
}

/** A project big enough that its listing is the largest thing in the prompt. */
function hugeTree(fileCount: number): FileTree {
  return {
    [ROOT]: Array.from({ length: fileCount }, (_, i) => ({
      path: `${ROOT}/component-with-a-long-name-${i}.tsx`,
      type: "file" as const,
    })),
  };
}

/** A turn that reads a file and reports back. `outputSize` drives the truncation tests. */
function toolTurn(turn: number, outputSize: number): NapEvent[] {
  const id = `tc_${turn}`;
  return [
    event("turn.started", turn, {}),
    userMessage(turn, `change number ${turn}`),
    toolCall(turn, id, { path: "src/App.tsx" }),
    toolResult(turn, id, "x".repeat(outputSize)),
    agentMessage(turn, `done with ${turn}`),
    event("turn.completed", turn, {
      usage: { inputTokens: 1, outputTokens: 1 },
      durationMs: 1,
      commitSha: null,
    }),
  ];
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

function blocks(messages: LLMMessage[]): LLMContentBlock[] {
  return messages.flatMap((m) => (typeof m.content === "string" ? [] : m.content));
}

function texts(messages: LLMMessage[]): string[] {
  return blocks(messages).flatMap((b) => (b.type === "text" ? [b.text] : []));
}

function toolResults(messages: LLMMessage[]) {
  return blocks(messages).flatMap((b) => (b.type === "tool_result" ? [b] : []));
}

function toolUses(messages: LLMMessage[]) {
  return blocks(messages).flatMap((b) => (b.type === "tool_use" ? [b] : []));
}

function blockText(block: LLMContentBlock): string {
  if (block.type === "text") return block.text;
  if (block.type === "tool_use") return `${block.name}${JSON.stringify(block.input)}`;
  return block.content;
}

/** Recomputes the cost of an assembled context from its parts, block by block. */
function totalTokens(systemPrompt: string, messages: LLMMessage[]): number {
  const messageTokens = blocks(messages)
    .map((block) => estimateTokens(blockText(block)))
    .reduce((total, tokens) => total + tokens, 0);

  return estimateTokens(systemPrompt) + messageTokens;
}

function projectTree(): FileTree {
  return {
    [ROOT]: [
      { path: `${ROOT}/src`, type: "directory" } satisfies FileNode,
      { path: `${ROOT}/package.json`, type: "file" },
    ],
    [`${ROOT}/src`]: [
      { path: `${ROOT}/src/App.tsx`, type: "file" },
      { path: `${ROOT}/src/main.tsx`, type: "file" },
    ],
  };
}

function request(overrides: Partial<ContextRequest> = {}): ContextRequest {
  return {
    sessionId: SESSION,
    sandboxId: SANDBOX,
    userMessage: "add a dark mode toggle",
    history: [],
    sandbox: stubSandbox(projectTree()),
    memory: new NoopMemoryProvider(),
    ...overrides,
  };
}

function engine(overrides = {}) {
  return new NapContextEngine({ root: ROOT, ...overrides });
}

// ---------------------------------------------------------------------------

describe("NapContextEngine", () => {
  describe("the system prompt", () => {
    it("is in the assembled prompt", async () => {
      const context = await engine().build(request());

      expect(context.systemPrompt).toContain(SYSTEM_PROMPT);
    });

    it("comes first, so the cacheable part of the prompt is stable", async () => {
      // Prompt caching matches on a byte-identical prefix. Anything that varies per turn —
      // the file tree, retrieved memories — has to sit after the part that never changes,
      // or the cache is invalidated on every request.
      const context = await engine().build(request());

      expect(context.systemPrompt.startsWith(SYSTEM_PROMPT)).toBe(true);
    });

    it("is present at the smallest permitted budget", async () => {
      const context = await engine({ budgetTokens: MIN_BUDGET_TOKENS }).build(
        request({ history: [...toolTurn(1, 8000), ...toolTurn(2, 8000)] }),
      );

      expect(context.systemPrompt).toContain(SYSTEM_PROMPT);
    });

    it("survives a history vastly larger than the budget", async () => {
      const history = Array.from({ length: 40 }, (_, i) => toolTurn(i + 1, 20_000)).flat();

      const context = await engine({ budgetTokens: MIN_BUDGET_TOKENS }).build(request({ history }));

      expect(context.systemPrompt).toContain(SYSTEM_PROMPT);
    });
  });

  describe("the conversation window", () => {
    it("replays prior messages in order", async () => {
      const history = [
        userMessage(1, "make it blue"),
        agentMessage(1, "made it blue"),
        userMessage(2, "now bigger"),
        agentMessage(2, "made it bigger"),
      ];

      const context = await engine().build(request({ history }));

      expect(texts(context.messages)).toEqual([
        "make it blue",
        "made it blue",
        "now bigger",
        "made it bigger",
        "add a dark mode toggle",
      ]);
    });

    it("attributes each message to who said it", async () => {
      const history = [userMessage(1, "make it blue"), agentMessage(1, "made it blue")];

      const context = await engine().build(request({ history }));

      expect(context.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    });

    it("ends with the message this turn is for", async () => {
      const context = await engine().build(
        request({ history: [userMessage(1, "earlier"), agentMessage(1, "ok")] }),
      );

      expect(texts(context.messages).at(-1)).toBe("add a dark mode toggle");
    });

    it("keeps only the most recent turns", async () => {
      const history = [1, 2, 3, 4, 5].flatMap((n) => [
        userMessage(n, `ask ${n}`),
        agentMessage(n, `answer ${n}`),
      ]);

      const context = await engine({ maxTurns: 2 }).build(request({ history }));

      expect(texts(context.messages)).toEqual([
        "ask 4",
        "answer 4",
        "ask 5",
        "answer 5",
        "add a dark mode toggle",
      ]);
    });

    it("carries tool calls and their results", async () => {
      const context = await engine().build(request({ history: toolTurn(1, 20) }));

      expect(toolUses(context.messages)).toHaveLength(1);
      expect(toolResults(context.messages)[0]?.content).toBe("x".repeat(20));
    });

    it("keeps a tool result attached to the call it answers", async () => {
      const context = await engine().build(request({ history: toolTurn(1, 20) }));

      expect(toolResults(context.messages)[0]?.toolCallId).toBe(toolUses(context.messages)[0]?.id);
    });

    it("preserves whether a tool failed", async () => {
      // A failed tool is how the model learns to try something else; replaying it as a
      // success would teach it the opposite of what happened.
      const history = [toolCall(1, "tc_1"), toolResult(1, "tc_1", "no such file", false)];

      const context = await engine().build(request({ history }));

      expect(toolResults(context.messages)[0]?.isError).toBe(true);
    });

    it("drops events that are not part of the conversation", async () => {
      // These are the client's business — progress for the UI to render — and none of them
      // is something the model said. Replaying summarized reasoning as an assistant turn in
      // particular would put words in its mouth that it never produced.
      const history = [
        userMessage(1, "make it blue"),
        thinking(1, "the user probably means the header"),
        event("file.changed", 1, { path: "src/App.tsx", changeType: "modified", diff: "@@ -1" }),
        event("command.output", 1, { toolCallId: "tc_1", stream: "stdout", chunk: "building" }),
        event("preview.ready", 1, { url: "https://example.com", port: 5173 }),
        event("turn.failed", 1, { reason: "internal", message: "boom" }),
        agentMessage(1, "made it blue"),
      ];

      const context = await engine().build(request({ history }));

      expect(texts(context.messages)).toEqual([
        "make it blue",
        "made it blue",
        "add a dark mode toggle",
      ]);
    });

    it("rejoins an answer the model streamed in pieces", async () => {
      // Prose now reaches the log as several events, because it is shown as it is written.
      // The conversation the model is re-sent has to look the way it did when it wrote it:
      // one answer, not a paragraph broken into the sizes the network happened to deliver.
      const history = [
        userMessage(1, "make it blue"),
        agentMessage(1, "I changed "),
        agentMessage(1, "the header colour."),
      ];

      const context = await engine().build(request({ history }));

      expect(texts(context.messages)).toEqual([
        "make it blue",
        "I changed the header colour.",
        "add a dark mode toggle",
      ]);
    });

    it("gives a rejoined answer one content block, not several", async () => {
      // Asserting on the blocks and not just the text: several text blocks in a row read
      // back the same, so a version that leaves them separate passes the test above while
      // sending the model a shape it never produced — and one that grows a block per event.
      const history = [
        userMessage(1, "make it blue"),
        agentMessage(1, "I changed "),
        agentMessage(1, "the header colour."),
      ];

      const context = await engine().build(request({ history }));
      const assistant = context.messages.find((message) => message.role === "assistant");

      expect(Array.isArray(assistant?.content) ? assistant.content : []).toEqual([
        { type: "text", text: "I changed the header colour." },
      ]);
    });

    it("still separates prose that a tool call came between", async () => {
      // Two answers with work in the middle are two things the model said, and joining them
      // would attribute the second half to before the tool ran.
      const history = [
        agentMessage(1, "Reading the file."),
        toolCall(1, "tc_1"),
        toolResult(1, "tc_1", "contents"),
        agentMessage(1, "It renders a heading."),
      ];

      const context = await engine().build(request({ history }));

      expect(texts(context.messages)).toEqual([
        "Reading the file.",
        "It renders a heading.",
        "add a dark mode toggle",
      ]);
    });
  });

  describe("the project's files", () => {
    it("are described in the system prompt", async () => {
      const context = await engine().build(request());

      expect(context.systemPrompt).toContain("src/App.tsx");
    });

    it("are omitted rather than faked when the sandbox cannot be read", async () => {
      const context = await engine().build(
        request({ sandbox: stubSandbox({}, { failing: [ROOT] }) }),
      );

      expect(context.systemPrompt).toContain(SYSTEM_PROMPT);
      expect(context.systemPrompt).not.toContain("<project_files>");
    });
  });

  describe("memories", () => {
    const remembering = (memories: Memory[]): MemoryProvider => ({
      retrieve: async () => memories,
      write: async () => {},
    });

    it("are interpolated when the provider returns some", async () => {
      const context = await engine().build(
        request({
          memory: remembering([{ id: "m1", content: "the user prefers tabs", score: 1 }]),
        }),
      );

      expect(context.systemPrompt).toContain("the user prefers tabs");
    });

    it("leave no trace at all under the no-op", async () => {
      // The seam has to be invisible when it is inert. An empty `<memories>` section would
      // be a section the model has to read and reason about on every turn of every session
      // in v1, in exchange for nothing.
      const context = await engine().build(request({ memory: new NoopMemoryProvider() }));

      expect(context.systemPrompt).not.toContain("memories");
    });

    it("produce byte-identical output to a provider that has nothing to say", async () => {
      const withNoop = await engine().build(request({ memory: new NoopMemoryProvider() }));
      const withEmpty = await engine().build(request({ memory: remembering([]) }));

      expect(withNoop.systemPrompt).toBe(withEmpty.systemPrompt);
      expect(withNoop.estimatedTokens).toBe(withEmpty.estimatedTokens);
    });

    it("are what a real provider would displace, not a special case", async () => {
      // Guards the two assertions above against being vacuous: the same assembler
      // demonstrably *does* change when a provider returns something, so their agreement
      // measures inertness rather than an assembler that ignores memory entirely.
      const withNoop = await engine().build(request({ memory: new NoopMemoryProvider() }));
      const withMemory = await engine().build(
        request({ memory: remembering([{ id: "m1", content: "prefers tabs", score: 1 }]) }),
      );

      expect(withMemory.systemPrompt).not.toBe(withNoop.systemPrompt);
    });
  });

  describe("the token budget", () => {
    it("rejects a budget too small to hold the system prompt", () => {
      // Programmer error, not an expected failure: there is no useful context to assemble
      // below this, and silently exceeding the number the caller asked for would be worse.
      expect(() => new NapContextEngine({ budgetTokens: MIN_BUDGET_TOKENS - 1 })).toThrow();
    });

    it("accepts the smallest permitted budget", () => {
      expect(() => new NapContextEngine({ budgetTokens: MIN_BUDGET_TOKENS })).not.toThrow();
    });

    it("reports what it actually assembled", async () => {
      const context = await engine().build(request({ history: toolTurn(1, 400) }));

      expect(context.estimatedTokens).toBe(totalTokens(context.systemPrompt, context.messages));
    });

    it.each([
      MIN_BUDGET_TOKENS,
      MIN_BUDGET_TOKENS + 100,
      MIN_BUDGET_TOKENS + 1_000,
      MIN_BUDGET_TOKENS + 5_000,
      2_000,
      10_000,
      DEFAULT_BUDGET_TOKENS,
    ])("never exceeds a budget of %i tokens", async (budgetTokens) => {
      const history = Array.from({ length: 30 }, (_, i) => toolTurn(i + 1, 5_000)).flat();

      const context = await engine({ budgetTokens }).build(request({ history }));

      expect(context.estimatedTokens).toBeLessThanOrEqual(budgetTokens);
      expect(totalTokens(context.systemPrompt, context.messages)).toBeLessThanOrEqual(budgetTokens);
    });

    it("holds the budget even when the current message alone would blow it", async () => {
      // The last thing that can be cut. Without this the invariant would be a wish: a user
      // can paste a whole file into the chat box.
      const context = await engine({ budgetTokens: MIN_BUDGET_TOKENS }).build(
        request({ userMessage: "z".repeat(200_000) }),
      );

      expect(context.estimatedTokens).toBeLessThanOrEqual(MIN_BUDGET_TOKENS);
      expect(context.systemPrompt).toContain(SYSTEM_PROMPT);
    });

    it("leaves everything intact when the budget is ample", async () => {
      const context = await engine().build(request({ history: toolTurn(1, 400) }));

      expect(toolResults(context.messages)[0]?.content).toBe("x".repeat(400));
      expect(context.systemPrompt).toContain("src/App.tsx");
    });
  });

  describe("truncation", () => {
    const heavy = () => Array.from({ length: 6 }, (_, i) => toolTurn(i + 1, 4_000)).flat();

    it("elides tool output oldest first", async () => {
      const context = await engine({ budgetTokens: 4_000 }).build(request({ history: heavy() }));
      const elided = toolResults(context.messages).map((r) => r.content === ELIDED_TOOL_OUTPUT);

      // Some had to go, but not all — otherwise the ordering claim is unobservable.
      expect(elided).toContain(true);
      expect(elided).toContain(false);
      // Once a surviving result appears, nothing after it may be elided.
      expect(elided.indexOf(false)).toBeGreaterThan(elided.lastIndexOf(true));
    });

    it("never leaves a tool call without its result", async () => {
      // The model provider rejects an unanswered tool call outright, so truncation that
      // deletes a result produces a request that fails rather than a smaller one. Eliding
      // the *content* keeps the pair; dropping a turn removes both halves together.
      for (const budgetTokens of [MIN_BUDGET_TOKENS, 2_000, 4_000, 8_000, 20_000]) {
        const context = await engine({ budgetTokens }).build(request({ history: heavy() }));

        const callIds = toolUses(context.messages).map((b) => b.id);
        const answeredIds = toolResults(context.messages).map((b) => b.toolCallId);

        expect(answeredIds).toEqual(callIds);
      }
    });

    it("drops whole turns oldest first once there is no output left to elide", async () => {
      // Prose, so step one has nothing to reclaim and the drop is what is being measured.
      const history = [1, 2, 3, 4, 5, 6].flatMap((n) => wordyTurn(n, 4_000));

      const context = await engine({ budgetTokens: 2_000 }).build(request({ history }));
      const rendered = texts(context.messages).join("\n");

      expect(rendered).toContain("change number 6");
      expect(rendered).not.toContain("change number 1");
    });

    it("gives up the file listing rather than the turn's own message", async () => {
      // The listing is a convenience the agent can rebuild with a single tool call. What
      // the user just asked for is not recoverable by any means.
      const context = await engine({ budgetTokens: MIN_BUDGET_TOKENS }).build(
        request({ sandbox: stubSandbox(hugeTree(400)), history: heavy() }),
      );

      expect(context.systemPrompt).not.toContain("<project_files>");
      expect(context.systemPrompt).toContain(SYSTEM_PROMPT);
      expect(texts(context.messages).at(-1)).toBe("add a dark mode toggle");
    });

    it("gives up the file listing before it gives up memories", async () => {
      // Pins the order of the last two steps. Memories are the smallest thing in the
      // prompt and the hardest to reconstruct — nothing else can go and fetch them.
      const memory: MemoryProvider = {
        retrieve: async () => [{ id: "m1", content: "the user prefers tabs", score: 1 }],
        write: async () => {},
      };

      const context = await engine({ budgetTokens: MIN_BUDGET_TOKENS }).build(
        request({ sandbox: stubSandbox(hugeTree(400)), memory }),
      );

      expect(context.systemPrompt).not.toContain("<project_files>");
      expect(context.systemPrompt).toContain("the user prefers tabs");
    });
  });

  describe("the sandbox", () => {
    it("is only ever listed, never read from or written to", async () => {
      // The stub throws on every other method, so a build that completes is the assertion:
      // assembling context is a read-only act on the project's shape.
      await expect(engine().build(request({ history: toolTurn(1, 100) }))).resolves.toBeDefined();
    });
  });
});
