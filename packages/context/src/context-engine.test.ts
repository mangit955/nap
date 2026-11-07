import type { NapEvent } from "@nap/shared/events";
import type { BuiltContext, ContextRequest, FailedAttempt } from "@nap/shared/ports/context-engine";
import type { LLMContentBlock, LLMMessage } from "@nap/shared/ports/llm-provider";
import type { Memory, MemoryProvider } from "@nap/shared/ports/memory-provider";
import { describe, expect, it } from "vitest";
import { prepareCompaction } from "./compaction.ts";
import {
  DEFAULT_BUDGET_TOKENS,
  ELIDED_TOOL_OUTPUT,
  MIN_BUDGET_TOKENS,
  NapContextEngine,
  type NapContextEngineOptions,
  STALE_TOOL_INPUT,
  STALE_TOOL_OUTPUT,
} from "./context-engine.ts";
import { FILE_LIST_UNAVAILABLE } from "./file-tree.ts";
import { NoopMemoryProvider } from "./noop-memory-provider.ts";
import { renderSteer } from "./steer.ts";
import { SUBAGENT_PROMPTS } from "./subagent-prompts.ts";
import { PLAN_MODE_PROMPT, REPOSITORY_SYSTEM_PROMPT, SYSTEM_PROMPT } from "./system-prompt.ts";
import { stubSandbox } from "./testing/stub-sandbox.ts";
import { estimateTokens } from "./tokens.ts";

const SESSION = "6f1c1d3e-2b7a-4c5e-8f9a-0d1e2f3a4b5c";
const SANDBOX = "sbx_1";
const ROOT = "/home/user/app";

it("uses repository guidance without the starter stack assumptions", async () => {
  const built = await new NapContextEngine().build(request({ workspace: "repository" }));
  expect(built.systemPrompt.startsWith(REPOSITORY_SYSTEM_PROMPT)).toBe(true);
  expect(built.systemPrompt).not.toContain(SYSTEM_PROMPT);
  // Compaction keeps these as the trusted half, so they must be the instructions this workspace ran under.
  expect(built.trustedInstructions).toBe(REPOSITORY_SYSTEM_PROMPT);
  expect(built.estimatedTokens).toBeLessThanOrEqual(DEFAULT_BUDGET_TOKENS);
});

it("offers an imported repository helpers and its root rules, and a Nap project neither", async () => {
  const repository = await new NapContextEngine().build(request({ workspace: "repository" }));
  expect(repository.subagentPrompts).toBe(SUBAGENT_PROMPTS);
  expect(repository.rootRules).toBe(true);

  const project = await new NapContextEngine().build(request());
  expect(project.subagentPrompts).toBeUndefined();
  expect(project.rootRules).toBeUndefined();
});

describe("plan mode", () => {
  const approved = { title: "Dark theme", plan: "1. Add colour tokens\n2. Add a toggle" };

  it("tells a plan mode turn it is planning, after the cached head, and an ordinary turn nothing", async () => {
    const planning = await engine().build(request({ mode: "plan" }));
    const building = await engine().build(request());
    expect(planning.systemPrompt.startsWith(SYSTEM_PROMPT)).toBe(true);
    expect(planning.systemPrompt).toContain(PLAN_MODE_PROMPT);
    expect(planning.systemPrompt.endsWith(PLAN_MODE_PROMPT)).toBe(true);
    expect(building.systemPrompt).not.toContain(PLAN_MODE_PROMPT);
    // The trusted half compaction keeps is the workspace's own instructions, not the mode's.
    expect(planning.trustedInstructions).toBe(SYSTEM_PROMPT);
  });

  it("plans for an imported repository too", async () => {
    const built = await engine().build(request({ mode: "plan", workspace: "repository" }));
    expect(built.systemPrompt.startsWith(REPOSITORY_SYSTEM_PROMPT)).toBe(true);
    expect(built.systemPrompt).toContain(PLAN_MODE_PROMPT);
  });

  it("hands the turn that carries out a plan the plan itself, word for word", async () => {
    const built = await engine().build(
      request({
        userMessage: "Approved. Build this plan.",
        job: { objective: "Dark theme", attempts: [], plan: approved },
      }),
    );
    expect(built.systemPrompt).not.toContain("<approved_plan>");
    expect(texts(built.messages).join("\n")).toContain("<approved_plan>");
    expect(texts(built.messages).join("\n")).toContain(approved.plan);
    expect(built.systemPrompt).not.toContain(PLAN_MODE_PROMPT);
  });

  it("keeps changing approved plans out of the cached system prompt", async () => {
    const first = await engine().build(
      request({
        job: { objective: approved.title, attempts: [], plan: approved },
      }),
    );
    const revised = { title: "Revised theme", plan: "Use the existing theme provider" };
    const second = await engine().build(
      request({
        job: { objective: revised.title, attempts: [], plan: revised },
      }),
    );
    expect(first.systemPrompt).toBe(second.systemPrompt);
    expect(first.trustedInstructions).toBe(second.trustedInstructions);
    expect(texts(first.messages).join("\n")).toContain(approved.plan);
    expect(texts(second.messages).join("\n")).toContain(revised.plan);
    expect(texts(second.messages).join("\n")).not.toContain(approved.plan);
  });

  it("keeps the approved plan on a repair turn, when the budget has cut everything it can", async () => {
    const attempts: FailedAttempt[] = [
      { check: "typecheck", detail: "exit 2", output: "x".repeat(40_000) },
    ];
    const built = await engine({ budgetTokens: MIN_BUDGET_TOKENS + 400 }).build(
      request({
        userMessage: "typecheck failed",
        job: { objective: "Dark theme", attempts, plan: approved },
      }),
    );
    expect(texts(built.messages).join("\n")).toContain(approved.plan);
  });
});

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

/** The end of a turn. Only a turn whose end is in the log is finished, and can go stale. */
const completed = (turn: number) =>
  event("turn.completed", turn, {
    usage: { inputTokens: 1, outputTokens: 1 },
    durationMs: 1,
    commitSha: null,
  });

/** A turn made of prose alone, so it can only be reclaimed by dropping the whole turn. */
function wordyTurn(turn: number, size: number): NapEvent[] {
  return [userMessage(turn, `change number ${turn}`), agentMessage(turn, "w".repeat(size))];
}

/**
 * A finished turn that writes a whole file — the shape that dominates a real session's
 * transcript.
 */
function writingTurn(turn: number, contentSize: number): NapEvent[] {
  const id = `wc_${turn}`;
  return [
    userMessage(turn, `change number ${turn}`),
    event("tool.call", turn, {
      toolCallId: id,
      toolName: "write_file",
      input: { path: "src/App.tsx", content: "c".repeat(contentSize) },
    }),
    event("tool.result", turn, {
      toolCallId: id,
      toolName: "write_file",
      ok: true,
      output: "y".repeat(contentSize),
    }),
    agentMessage(turn, `done with ${turn}`),
    completed(turn),
  ];
}

/** A project big enough that its listing is the largest thing in the prompt. */
function hugeTree(fileCount: number): string[] {
  return Array.from({ length: fileCount }, (_, i) => `${ROOT}/component-with-a-long-name-${i}.tsx`);
}

/** A turn that reads a file and reports back. `outputSize` drives the truncation tests. */
function toolTurn(turn: number, outputSize: number): NapEvent[] {
  const id = `tc_${turn}`;
  return [
    event("turn.started", turn, { source: "user" }),
    userMessage(turn, `change number ${turn}`),
    toolCall(turn, id, { path: "src/App.tsx" }),
    toolResult(turn, id, "x".repeat(outputSize)),
    agentMessage(turn, `done with ${turn}`),
    completed(turn),
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
  if (block.type === "image") return "";
  if (typeof block.content !== "string") throw new Error("Expected a text-only fixture result");
  return block.content;
}

/** Recomputes the cost of an assembled context from its parts, block by block. */
function totalTokens(systemPrompt: string, messages: LLMMessage[]): number {
  const messageTokens = blocks(messages)
    .map((block) => estimateTokens(blockText(block)))
    .reduce((total, tokens) => total + tokens, 0);

  return estimateTokens(systemPrompt) + messageTokens;
}

function projectTree(): string[] {
  return [`${ROOT}/package.json`, `${ROOT}/src/App.tsx`, `${ROOT}/src/main.tsx`];
}

/**
 * Everything the model is told, wherever it sits. Most assertions here are about *whether* the
 * model hears something; where in the request it rides is pinned once, in "the system prompt".
 */
function told(context: BuiltContext): string {
  return [context.systemPrompt, ...texts(context.messages)].join("\n");
}

/** What was said, in order, without the turn's context riding on the end of the last message. */
function conversation(context: BuiltContext): string[] {
  const all = texts(context.messages);
  return turnContextOf(context) === "" ? all : all.slice(0, -1);
}

/** The text the turn's own message carries after the request itself: the turn's context. */
function turnContextOf(context: BuiltContext): string {
  const last = context.messages.at(-1);
  if (last === undefined || typeof last.content === "string") return "";
  return last.content
    .slice(1)
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n");
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

/**
 * More past turns than any fixture here has, so staleness reaches none of them. Named because
 * a bare 99 reads as "off", and it is not — it is "off for a history this short".
 */
const KEEP_EVERY_TURN = 99;

function engine(overrides: Partial<NapContextEngineOptions> = {}) {
  return new NapContextEngine({ root: ROOT, ...overrides });
}

// ---------------------------------------------------------------------------

describe("NapContextEngine", () => {
  describe("the system prompt", () => {
    it("is in the assembled prompt", async () => {
      const context = await engine().build(request());

      expect(context.systemPrompt).toContain(SYSTEM_PROMPT);
    });

    it("is the whole system prompt, so the cacheable prefix is the same on every turn", async () => {
      // Prompt caching matches on a byte-identical prefix, rendered tools, then system, then
      // messages. Anything that varies per turn — the file listing, a job brief, memories —
      // anywhere in the system prompt invalidates the conversation behind it on every turn.
      const plain = await engine().build(request());
      const busy = await engine().build(
        request({
          sandbox: stubSandbox([...projectTree(), `${ROOT}/src/Added.tsx`]),
          job: {
            objective: "something else entirely",
            attempts: [{ check: "test", detail: "exited 1", output: "FAIL" }],
          },
          memory: {
            retrieve: async () => [{ id: "m1", content: "prefers tabs", score: 1 }],
            write: async () => {},
          },
        }),
      );

      expect(plain.systemPrompt).toBe(SYSTEM_PROMPT);
      expect(busy.systemPrompt).toBe(SYSTEM_PROMPT);
    });

    it("leaves what changes per turn to the turn's own message, after the request", async () => {
      const context = await engine().build(
        request({ job: { objective: "an older objective", attempts: [] } }),
      );

      const last = context.messages.at(-1);
      expect(last?.role).toBe("user");
      expect(texts(last === undefined ? [] : [last])[0]).toBe("add a dark mode toggle");
      expect(turnContextOf(context)).toContain("<project_files>");
      expect(turnContextOf(context)).toContain("<job>");
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

      expect(conversation(context)).toEqual([
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

      expect(conversation(context).at(-1)).toBe("add a dark mode toggle");
    });

    it("keeps the most recent exchanges and every original request once", async () => {
      const history = [1, 2, 3, 4, 5].flatMap((n) => [
        userMessage(n, `ask ${n}`),
        agentMessage(n, `answer ${n}`),
      ]);

      const context = await engine({ maxTurns: 2 }).build(request({ history }));

      expect(conversation(context)).toEqual([
        "ask 1",
        "ask 2",
        "ask 3",
        "ask 4",
        "answer 4",
        "ask 5",
        "answer 5",
        "add a dark mode toggle",
      ]);
    });

    it("carries tool calls and their results", async () => {
      const context = await engine({ verbatimTurns: KEEP_EVERY_TURN }).build(
        request({ history: toolTurn(1, 20) }),
      );

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

      expect(conversation(context)).toEqual([
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

      expect(conversation(context)).toEqual([
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

      expect(conversation(context)).toEqual([
        "Reading the file.",
        "It renders a heading.",
        "add a dark mode toggle",
      ]);
    });
  });

  describe("the project's files", () => {
    it("are described to the model", async () => {
      const context = await engine().build(request());

      expect(told(context)).toContain("src/App.tsx");
    });

    it("are said to be unavailable, not faked or failed, when the sandbox cannot list them", async () => {
      const context = await engine().build(
        request({ sandbox: stubSandbox([], { failing: true }) }),
      );

      expect(context.systemPrompt).toBe(SYSTEM_PROMPT);
      expect(turnContextOf(context)).toContain(FILE_LIST_UNAVAILABLE);
    });

    it("are listed with one sandbox call per build", async () => {
      let calls = 0;
      await engine().build(
        request({ sandbox: stubSandbox(projectTree(), { onListTree: () => (calls += 1) }) }),
      );

      expect(calls).toBe(1);
    });
  });

  describe("the project's skills", () => {
    const SKILL = `${ROOT}/.nap/skills/add-migration/SKILL.md`;
    const withSkill = (description = "Adding a database migration") =>
      stubSandbox([...projectTree(), SKILL], {
        skills: {
          [SKILL]: `---\nname: add-migration\ndescription: ${description}\n---\nRun drizzle-kit generate.`,
        },
      });
    const discovered = (turn: number, description: string) =>
      event("skills.discovered", turn, {
        skills: [{ name: "add-migration", description, path: SKILL }],
        skipped: [],
      });

    it("are listed in the turn's own message and never in the system prompt", async () => {
      // The system prompt heads every cached prefix (ADR-0024); a skill edited mid-session must
      // change only what a later request does not repeat.
      const context = await engine().build(request({ sandbox: withSkill() }));

      expect(turnContextOf(context)).toContain("- add-migration: Adding a database migration");
      expect(context.systemPrompt).not.toContain("add-migration");
      expect(context.skills?.index.skills.map((s) => s.name)).toEqual(["add-migration"]);
    });

    it("leave nothing in the prompt of a project that has none", async () => {
      const context = await engine().build(request());

      expect(told(context)).not.toContain("<project_skills>");
      expect(context.skills?.announce).toBe(false);
    });

    it("are announced when they differ from the last record, and only then", async () => {
      const first = await engine().build(request({ sandbox: withSkill() }));
      const same = await engine().build(
        request({
          sandbox: withSkill(),
          history: [discovered(1, "Adding a database migration")],
        }),
      );
      const edited = await engine().build(
        request({
          sandbox: withSkill("Migrations, the drizzle way"),
          history: [discovered(1, "x")],
        }),
      );

      expect(first.skills?.announce).toBe(true);
      expect(same.skills?.announce).toBe(false);
      expect(edited.skills?.announce).toBe(true);
    });

    it("are given up after the file listing and before memories", async () => {
      const memory: MemoryProvider = {
        retrieve: async () => [{ id: "m1", content: "the user prefers tabs", score: 1 }],
        write: async () => {},
      };
      // As many skills as a project may have, each with as long a description as it may have.
      const paths = Array.from({ length: 32 }, (_, i) => `${ROOT}/.nap/skills/s${i}/SKILL.md`);
      const sandbox = stubSandbox([...hugeTree(400), ...paths], {
        skills: Object.fromEntries(
          paths.map((path, i) => [
            path,
            `---\nname: s${i}\ndescription: ${"d".repeat(480)}\n---\nBody.`,
          ]),
        ),
      });

      const context = await engine({ budgetTokens: MIN_BUDGET_TOKENS }).build(
        request({ sandbox, memory }),
      );

      expect(told(context)).not.toContain("<project_files>");
      expect(told(context)).not.toContain("<project_skills>");
      expect(told(context)).toContain("the user prefers tabs");
      // Out of the prompt, but still known: the tool loads by name from the same index.
      expect(context.skills?.index.skills).toHaveLength(32);
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

      expect(told(context)).toContain("the user prefers tabs");
    });

    it("leave no trace at all under the no-op", async () => {
      // The seam has to be invisible when it is inert. An empty `<memories>` section would
      // be a section the model has to read and reason about on every turn of every session
      // in v1, in exchange for nothing.
      const context = await engine().build(request({ memory: new NoopMemoryProvider() }));

      expect(told(context)).not.toContain("memories");
    });

    it("produce byte-identical output to a provider that has nothing to say", async () => {
      const withNoop = await engine().build(request({ memory: new NoopMemoryProvider() }));
      const withEmpty = await engine().build(request({ memory: remembering([]) }));

      expect(told(withNoop)).toBe(told(withEmpty));
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

      expect(told(withMemory)).not.toBe(told(withNoop));
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
    ])("fits a budget of %i tokens when protected requests fit", async (budgetTokens) => {
      const history = Array.from({ length: 30 }, (_, i) => toolTurn(i + 1, 5_000)).flat();

      const context = await engine({ budgetTokens }).build(request({ history }));

      expect(context.estimatedTokens).toBeLessThanOrEqual(budgetTokens);
      expect(totalTokens(context.systemPrompt, context.messages)).toBeLessThanOrEqual(budgetTokens);
    });

    it("preserves an oversized current request so the loop can refuse instead of silently deleting instructions", async () => {
      // The size is reported honestly; ending the turn belongs to the active loop.
      const context = await engine({ budgetTokens: MIN_BUDGET_TOKENS }).build(
        request({ userMessage: "z".repeat(200_000) }),
      );

      expect(context.estimatedTokens).toBeGreaterThan(MIN_BUDGET_TOKENS);
      expect(context.needsCompaction).toBe(true);
      expect(texts(context.messages)).toContain("z".repeat(200_000));
      expect(context.systemPrompt).toContain(SYSTEM_PROMPT);
    });

    it("leaves everything intact when the budget is ample", async () => {
      const context = await engine({ verbatimTurns: KEEP_EVERY_TURN }).build(
        request({ history: toolTurn(1, 400) }),
      );

      expect(toolResults(context.messages)[0]?.content).toBe("x".repeat(400));
      expect(told(context)).toContain("src/App.tsx");
    });
  });

  describe("truncation", () => {
    const heavy = () => Array.from({ length: 6 }, (_, i) => toolTurn(i + 1, 4_000)).flat();

    /**
     * An engine that keeps every past turn word for word, so the ladder is what is under
     * test. Under the default the staleness pass has already emptied all but the newest turn
     * before the budget is consulted, and each step below would be pinned on nothing.
     */
    const ladder = (overrides: Partial<NapContextEngineOptions> = {}) =>
      engine({ verbatimTurns: KEEP_EVERY_TURN, ...overrides });

    it("elides tool output oldest first", async () => {
      const context = await ladder({ budgetTokens: 4_000 }).build(request({ history: heavy() }));
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
        const context = await ladder({ budgetTokens }).build(request({ history: heavy() }));

        const callIds = toolUses(context.messages).map((b) => b.id);
        const answeredIds = toolResults(context.messages).map((b) => b.toolCallId);

        expect(answeredIds).toEqual(callIds);
      }
    });

    it("evicts old exchanges while retaining their original requests", async () => {
      // Prose, so step one has nothing to reclaim and the drop is what is being measured.
      const history = [1, 2, 3, 4, 5, 6].flatMap((n) => wordyTurn(n, 4_000));

      const context = await ladder({ budgetTokens: 2_000 }).build(request({ history }));
      const rendered = texts(context.messages).join("\n");

      expect(rendered).toContain("change number 6");
      expect(rendered).toContain("change number 1");
      for (let i = 1; i <= 6; i++)
        expect(
          texts(context.messages).filter((text) => text === `change number ${i}`),
        ).toHaveLength(1);
      expect(
        context.messages.filter((message) => message.role === "assistant").length,
      ).toBeLessThan(6);
    });

    it("gives up the file listing rather than the turn's own message", async () => {
      // The listing is a convenience the agent can rebuild with a single tool call. What
      // the user just asked for is not recoverable by any means.
      const context = await ladder({ budgetTokens: MIN_BUDGET_TOKENS }).build(
        request({ sandbox: stubSandbox(hugeTree(400)), history: heavy() }),
      );

      expect(told(context)).not.toContain("<project_files>");
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

      expect(told(context)).not.toContain("<project_files>");
      expect(told(context)).toContain("the user prefers tabs");
    });
  });

  describe("staleness", () => {
    // The budget here is never in danger — that is the point. Everything below happens
    // because carrying an old turn's file contents through every round trip of the next turn
    // is not worth what it costs, not because the context failed to fit.
    const roomy = () => engine({ budgetTokens: DEFAULT_BUDGET_TOKENS });
    const threeWrites = () => [1, 2, 3].flatMap((n) => writingTurn(n, 4_000));

    it("drops what every finished turn wrote, while the budget is nowhere near binding", async () => {
      // The most recent one included. Emptying a turn one turn late would rewrite history the
      // previous request had already cached, and every turn's first call would pay for all of
      // it again (ADR-0024).
      const context = await roomy().build(request({ history: threeWrites() }));

      expect(context.estimatedTokens).toBeLessThan(DEFAULT_BUDGET_TOKENS);
      const written = toolUses(context.messages).map((b) => b.input.content);
      expect(written).toEqual([STALE_TOOL_INPUT, STALE_TOOL_INPUT, STALE_TOOL_INPUT]);
    });

    it.each([true, false])(
      "keeps a turn still running word for word, with continuation %s",
      async (continuation) => {
        // A rebuild in the middle of a turn sees that turn's events and no end for them. What it
        // has just written is what it is about to need — and an app test's rebuild re-adds its
        // prompt, so it is not a continuation, and its turn is running all the same.
        const running = writingTurn(3, 4_000).slice(0, -1);
        const history = [...writingTurn(1, 4_000), ...writingTurn(2, 4_000), ...running];

        const context = await roomy().build(request({ history, continuation }));

        expect(toolUses(context.messages).at(-1)?.input.content).toBe("c".repeat(4_000));
        expect(toolResults(context.messages).at(-1)?.content).toBe("y".repeat(4_000));
        expect(toolUses(context.messages).at(-2)?.input.content).toBe(STALE_TOOL_INPUT);
      },
    );

    it("counts a turn that failed or was cancelled as finished", async () => {
      const cancelled = [
        ...writingTurn(1, 4_000).slice(0, -1),
        event("turn.failed", 1, { reason: "cancelled", message: "stopped" }),
      ];

      const context = await roomy().build(request({ history: cancelled }));

      expect(toolUses(context.messages)[0]?.input.content).toBe(STALE_TOOL_INPUT);
      expect(toolResults(context.messages)[0]?.content).toBe(STALE_TOOL_OUTPUT);
    });

    it("keeps a question to the person whole on the turn that answers it", async () => {
      // The answer arrives as the next turn's message, and is often only the label of the option
      // picked. The question and what each option meant are in no file the model could re-read.
      const question = `Which layout should the dashboard use? ${"It shows revenue and churn. ".repeat(4)}`;
      const options = [
        { label: "Grid", description: `Cards in a responsive grid. ${"Dense. ".repeat(10)}` },
        { label: "List", description: `One metric per row, full width. ${"Calm. ".repeat(10)}` },
      ];
      const asking = [
        userMessage(1, "build me a dashboard"),
        event("tool.call", 1, {
          toolCallId: "ask_1",
          toolName: "ask_user",
          input: { question, options, multiSelect: false },
        }),
        event("tool.result", 1, {
          toolCallId: "ask_1",
          toolName: "ask_user",
          ok: true,
          output: "Question shown to the user.",
        }),
        completed(1),
      ];

      const context = await roomy().build(request({ history: asking, userMessage: "Grid" }));

      expect(toolUses(context.messages)[0]?.input).toEqual({
        question,
        options,
        multiSelect: false,
      });
    });

    it("never rewrites history a previous turn's request already sent", async () => {
      // The cache's condition, at the level this class owns: the conversation the previous
      // turn's first request carried is a prefix of this turn's, block for block.
      const twoWrites = [1, 2].flatMap((n) => writingTurn(n, 4_000));
      const before = await roomy().build(request({ history: twoWrites }));
      const after = await roomy().build(request({ history: threeWrites() }));

      const settled = before.messages
        .slice(0, -1)
        .map(({ cacheBreakpoint: _, ...message }) => message);
      expect(
        after.messages
          .slice(0, settled.length)
          .map(({ cacheBreakpoint: _, ...message }) => message),
      ).toEqual(settled);
    });

    it("keeps the small arguments that say what an old call was about", async () => {
      // A path is what makes an elided call still readable as an event that happened. Losing
      // it would leave the model a call it cannot attribute to anything.
      const context = await roomy().build(request({ history: threeWrites() }));

      expect(toolUses(context.messages).map((b) => b.input.path)).toEqual([
        "src/App.tsx",
        "src/App.tsx",
        "src/App.tsx",
      ]);
    });

    it("keeps what was asked and what was answered", async () => {
      // Prose is 2% of a real transcript and the only part of an old turn that is not
      // recoverable from the workspace, so nothing here may touch it.
      const context = await roomy().build(request({ history: threeWrites() }));

      expect(conversation(context)).toEqual([
        "change number 1",
        "done with 1",
        "change number 2",
        "done with 2",
        "change number 3",
        "done with 3",
        "add a dark mode toggle",
      ]);
    });

    it("says the removal was about age, not about room", async () => {
      // The budget's marker would tell the model there was no space, on a turn with 100,000
      // tokens of it. Which reason the model reads is the whole distinction this pass draws
      // against truncation, so the two markers are not interchangeable.
      const context = await roomy().build(request({ history: threeWrites() }));
      const marks = [
        ...toolResults(context.messages).map((b) => b.content),
        ...toolUses(context.messages).map((b) => b.input.content),
      ];

      expect(marks).not.toContain(ELIDED_TOOL_OUTPUT);
      expect(new Set(marks)).toEqual(new Set([STALE_TOOL_OUTPUT, STALE_TOOL_INPUT]));
    });

    it("measures an argument that is not a string", async () => {
      // Every tool takes strings today. A rule that looked at `typeof value === "string"`
      // would let the first array-valued argument through in full and silently.
      const id = "tc_list";
      const history = [
        userMessage(1, "rewrite them all"),
        event("tool.call", 1, {
          toolCallId: id,
          toolName: "write_file",
          input: { paths: Array.from({ length: 200 }, (_, i) => `src/component-${i}.tsx`) },
        }),
        event("tool.result", 1, { toolCallId: id, toolName: "write_file", ok: true, output: "" }),
        completed(1),
        ...writingTurn(2, 100),
      ];

      const context = await roomy().build(request({ history }));

      expect(toolUses(context.messages)[0]?.input.paths).toBe(STALE_TOOL_INPUT);
    });

    it("still answers every call it kept", async () => {
      const context = await roomy().build(request({ history: threeWrites() }));

      expect(toolResults(context.messages).map((b) => b.toolCallId)).toEqual(
        toolUses(context.messages).map((b) => b.id),
      );
    });

    it("reaches nothing when every turn is asked for verbatim", async () => {
      // The guard's own failure case: with no turn stale the assertions above invert, which
      // is what makes them evidence that the pass is doing the work.
      const context = await engine({ verbatimTurns: KEEP_EVERY_TURN }).build(
        request({ history: threeWrites() }),
      );

      expect(toolUses(context.messages).map((b) => b.input.content)).toEqual([
        "c".repeat(4_000),
        "c".repeat(4_000),
        "c".repeat(4_000),
      ]);
    });

    it("refuses a negative count rather than clamping it", () => {
      // A wiring mistake, not an outcome — and a silent clamp would look like a decision.
      expect(() => engine({ verbatimTurns: -1 })).toThrow(/verbatim turns/);
    });

    it("leaves the caller's history untouched", async () => {
      // The turns are mutated in place, so a history array shared with anything else would
      // come back emptied. `toTurns` copies; this is what says so.
      const history = threeWrites();
      const before = JSON.stringify(history);

      await roomy().build(request({ history }));

      expect(JSON.stringify(history)).toBe(before);
    });
  });

  describe("the exchange a compaction kept", () => {
    const TAIL = "tail_write";
    const written = "c".repeat(4_000);
    const printed = "y".repeat(4_000);

    /** Turn 1, compacted in its middle, keeping its last write word for word to carry on from. */
    function compactedMidTurn(): NapEvent[] {
      const events = [
        userMessage(1, "build it"),
        event("tool.call", 1, {
          toolCallId: TAIL,
          toolName: "write_file",
          input: { path: "src/App.tsx", content: written },
        }),
        event("tool.result", 1, {
          toolCallId: TAIL,
          toolName: "write_file",
          ok: true,
          output: printed,
        }),
      ];
      const coveredThrough = events.at(-1)?.seq ?? 0;
      return [
        ...events,
        event("compaction.completed", 1, {
          id: turnId(1),
          result: {
            kind: "api",
            checkpoint: {
              coveredThrough,
              summary: "Wrote the app shell.",
              tail: [
                {
                  role: "assistant",
                  content: [
                    {
                      type: "tool_use",
                      id: TAIL,
                      name: "write_file",
                      input: { path: "src/App.tsx", content: written },
                    },
                  ],
                },
                {
                  role: "user",
                  content: [
                    { type: "tool_result", toolCallId: TAIL, content: printed, isError: false },
                  ],
                },
              ],
            },
          },
          usage: null,
          beforeTokens: null,
          afterTokens: null,
        }),
      ];
    }

    const tailOf = (context: BuiltContext) => ({
      input: toolUses(context.messages).find((block) => block.id === TAIL)?.input.content,
      output: toolResults(context.messages).find((block) => block.toolCallId === TAIL)?.content,
    });

    it.each([true, false])(
      "stays word for word while its turn is still running, with continuation %s",
      async (continuation) => {
        const context = await engine().build(
          request({ history: compactedMidTurn(), continuation }),
        );

        expect(tailOf(context)).toEqual({ input: written, output: printed });
      },
    );

    it("goes stale with its turn once that turn has finished", async () => {
      // Kept for every later turn instead, it is one whole tool exchange re-sent on every step
      // until the next compaction.
      const history = [
        ...compactedMidTurn(),
        agentMessage(1, "done"),
        completed(1),
        ...writingTurn(2, 100),
      ];

      const context = await engine().build(request({ history }));

      expect(tailOf(context)).toEqual({ input: STALE_TOOL_INPUT, output: STALE_TOOL_OUTPUT });
    });

    it("is treated as finished when the call it kept is not in the log", async () => {
      const history = compactedMidTurn().filter((stored) => stored.type === "compaction.completed");

      const context = await engine().build(request({ history }));

      expect(tailOf(context)).toEqual({ input: STALE_TOOL_INPUT, output: STALE_TOOL_OUTPUT });
    });

    it("belongs to the newest call with its id, should an earlier finished turn have reused it", async () => {
      // Real providers mint unique ids; a scripted one may not. The kept exchange is the latest.
      const earlier = [
        userMessage(0, "an earlier turn"),
        toolCall(0, TAIL, { path: "src/App.tsx" }),
        toolResult(0, TAIL, "old"),
        completed(0),
      ];

      const context = await engine().build(
        request({ history: [...earlier, ...compactedMidTurn()], continuation: true }),
      );

      expect(tailOf(context)).toEqual({ input: written, output: printed });
    });

    it("leaves its breakpoint on settled history, not on this turn's context", async () => {
      // A rebuild ends on the kept exchange. Extending that message with the turn's context would
      // put the breakpoint on bytes the next turn does not repeat, so nothing written there could
      // ever be read.
      const context = await engine().build(
        request({ history: compactedMidTurn(), continuation: true }),
      );
      const marked = context.messages.filter((message) => message.cacheBreakpoint === true);
      const last = context.messages.at(-1);

      expect(marked.length).toBeGreaterThan(0);
      for (const message of marked)
        expect(JSON.stringify(message)).not.toContain("<project_files>");
      expect(last?.cacheBreakpoint).toBeUndefined();
      expect(texts(last === undefined ? [] : [last]).join("\n")).toContain("<project_files>");
    });
  });

  describe("the job", () => {
    const failure = (overrides: Partial<FailedAttempt> = {}): FailedAttempt => ({
      check: "test",
      detail: "exited 1",
      output: "FAIL src/App.test.tsx",
      ...overrides,
    });

    /** A repair turn: the message is the verifier's prompt, the objective is the user's. */
    const repairing = (attempts: readonly FailedAttempt[]): Partial<ContextRequest> => ({
      userMessage: "the `test` check failed; find the cause and fix it",
      job: { objective: "add a dark mode toggle", attempts },
    });

    it("is absent from the prompt for a caller that tracks none", async () => {
      const context = await engine().build(request());

      expect(told(context)).not.toContain("<job>");
    });

    it("leaves the prompt untouched when the turn's message is the objective itself", async () => {
      // The first turn of a job. Restating the message directly below it is a section paid
      // for on every opening turn of every job in exchange for nothing.
      const withoutJob = await engine().build(request());
      const withJob = await engine().build(
        request({ job: { objective: "add a dark mode toggle", attempts: [] } }),
      );

      expect(told(withJob)).toBe(told(withoutJob));
    });

    it("states the objective on a turn whose message is not it", async () => {
      const context = await engine().build(request(repairing([])));

      expect(told(context)).toContain("<job>");
      expect(told(context)).toContain("add a dark mode toggle");
    });

    it("carries the failures already seen", async () => {
      const context = await engine().build(
        request(repairing([failure({ check: "typecheck", output: "error TS2322" })])),
      );

      expect(told(context)).toContain("typecheck");
      expect(told(context)).toContain("error TS2322");
    });

    it("survives the budget that drops the conversation it came from", async () => {
      // The whole point of the section. A long repair is exactly the situation where the
      // turn that stated the objective has fallen out of the window, so an objective that
      // goes with it would leave the model repairing checks with no idea what it is building.
      const history = [1, 2, 3, 4, 5, 6].flatMap((n) => wordyTurn(n, 4_000));

      const context = await engine({ budgetTokens: 2_000 }).build(
        request({ ...repairing([failure()]), history }),
      );

      expect(told(context)).toContain("add a dark mode toggle");
      expect(told(context)).toContain("FAIL src/App.test.tsx");
      expect(texts(context.messages).join("\n")).toContain("change number 1");
      expect(
        context.messages.filter((message) => message.role === "assistant").length,
      ).toBeLessThan(6);
    });

    it("outlives the file listing and the memories", async () => {
      const memory: MemoryProvider = {
        retrieve: async () => [{ id: "m1", content: "the user prefers tabs", score: 1 }],
        write: async () => {},
      };

      // A failure large enough that something has to go: without the pressure the ordering
      // claim is unobservable, because everything fits and nothing is given up at all.
      const context = await engine({ budgetTokens: MIN_BUDGET_TOKENS + 200 }).build(
        request({
          ...repairing([failure({ output: "x".repeat(8_000) })]),
          sandbox: stubSandbox(hugeTree(400)),
          memory,
        }),
      );

      expect(told(context)).not.toContain("<project_files>");
      expect(told(context)).not.toContain("the user prefers tabs");
      expect(told(context)).toContain("add a dark mode toggle");
    });

    it("gives up the oldest failures before the one being repaired now", async () => {
      const attempts = [
        failure({ check: "typecheck", output: "the oldest failure" }),
        failure({ check: "lint", output: "the middle failure" }),
        failure({ check: "test", output: "the newest failure" }),
        // Long enough that they cannot all fit, and marked at the end, because what a
        // shortened quote keeps is its tail.
      ].map((attempt) => ({ ...attempt, output: `${"x".repeat(8_000)} ${attempt.output}` }));

      const context = await engine({ budgetTokens: MIN_BUDGET_TOKENS + 500 }).build(
        request(repairing(attempts)),
      );

      expect(told(context)).toContain("the newest failure");
      expect(told(context)).not.toContain("the oldest failure");
    });

    it.each([MIN_BUDGET_TOKENS, MIN_BUDGET_TOKENS + 1_000, 10_000, DEFAULT_BUDGET_TOKENS])(
      "never exceeds a budget of %i tokens with a job and a full history",
      async (budgetTokens) => {
        const history = Array.from({ length: 30 }, (_, i) => toolTurn(i + 1, 5_000)).flat();
        const attempts = [1, 2, 3].map(() => failure({ output: "z".repeat(200_000) }));

        const context = await engine({ budgetTokens }).build(
          request({ ...repairing(attempts), history }),
        );

        expect(context.estimatedTokens).toBeLessThanOrEqual(budgetTokens);
        expect(totalTokens(context.systemPrompt, context.messages)).toBeLessThanOrEqual(
          budgetTokens,
        );
      },
    );

    it("holds the budget against a failure that printed more than the budget", async () => {
      // Near-unevictable is not unevictable: a check can print a megabyte, and the guarantee
      // that the assembled context fits is not allowed to become a hope because of it.
      const context = await engine({ budgetTokens: MIN_BUDGET_TOKENS }).build(
        request(repairing([failure({ output: "y".repeat(400_000) })])),
      );

      expect(context.estimatedTokens).toBeLessThanOrEqual(MIN_BUDGET_TOKENS);
      expect(totalTokens(context.systemPrompt, context.messages)).toBeLessThanOrEqual(
        MIN_BUDGET_TOKENS,
      );
      // Still says what was asked and which check said no, having given up only the quote.
      expect(told(context)).toContain("add a dark mode toggle");
      expect(told(context)).toContain("test");
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

describe("media in context", () => {
  const attachment = {
    kind: "image",
    name: "reference.jpg",
    frames: [{ mediaType: "image/jpeg", data: "/9j/AAAA", timestamp: 0 }],
  } as const;
  const attachments = [{ ...attachment, frames: [...attachment.frames] }];

  it.each(["window", "budget", "checkpoint"] as const)(
    "keeps old request text and named media references once after %s eviction",
    async (eviction) => {
      const history = [
        event("user.message", 1, {
          text: "Never deploy. Match the first reference.",
          attachments: [
            {
              kind: "video",
              name: "first.mp4",
              duration: 8,
              frames: [{ timestamp: 1.5, mediaType: "image/jpeg", data: "AAAA" }],
            },
          ],
        }),
        agentMessage(1, "w".repeat(4_000)),
      ];
      if (eviction === "checkpoint")
        history.push(
          event("compaction.completed", 1, {
            id: crypto.randomUUID(),
            result: {
              kind: "api",
              checkpoint: {
                coveredThrough: history.at(-1)!.seq,
                summary: "earlier work",
                tail: [],
              },
            },
            beforeTokens: 8_000,
            afterTokens: 1_000,
            usage: null,
          }),
        );
      history.push(
        event("user.message", 2, { text: "Match the second reference too.", attachments }),
        agentMessage(2, "OK"),
      );
      const original = structuredClone(history);
      const result = await new NapContextEngine({
        maxTurns: eviction === "window" ? 1 : 20,
        budgetTokens: eviction === "budget" ? 4_000 : 80_000,
      }).build(request({ history, model: "openai/gpt-5.6-luna" }));
      const userText = texts(result.messages.filter((message) => message.role === "user")).join(
        "\n",
      );
      for (const text of [
        "Never deploy. Match the first reference.",
        "Match the second reference too.",
        "first.mp4",
        "reference.jpg",
      ])
        expect(userText.split(text)).toHaveLength(2);
      expect(userText).toContain("Frame at 1.5s");
      expect(blocks(result.messages).filter((block) => block.type === "image")).toEqual([
        { type: "image", mediaType: "image/jpeg", data: "/9j/AAAA" },
      ]);
      expect(history).toEqual(original);
    },
  );

  it.each(["nvidia/nemotron-3-ultra-550b-a55b:free", "custom/unknown-model"])(
    "keeps text usable on %s while preserving references for a later vision turn",
    async (model) => {
      const history = [event("user.message", 1, { text: "Use this reference", attachments })];
      const original = structuredClone(history);
      const engine = new NapContextEngine();
      const textRequest = { ...request({ history }), model };
      const textOnly = await engine.build(textRequest);

      expect(blocks(textOnly.messages).filter((block) => block.type === "image")).toEqual([]);
      expect(texts(textOnly.messages).join("\n")).toContain("Use this reference");
      expect(texts(textOnly.messages).join("\n")).toMatch(/reference\.jpg.*omitted.*model/i);
      expect(texts(textOnly.messages).join("\n")).toContain("add a dark mode toggle");
      expect(history).toEqual(original);

      const visionRequest = { ...request({ history }), model: "anthropic/claude-opus-5" };
      const vision = await engine.build(visionRequest);
      expect(blocks(vision.messages)).toContainEqual({
        type: "image",
        mediaType: "image/jpeg",
        data: "/9j/AAAA",
      });
      expect(history).toEqual(original);
    },
  );

  it("sends image blocks alongside the current prompt and accounts for their token cost", async () => {
    const engine = new NapContextEngine();
    const plain = await engine.build(request());
    const withImage = await engine.build(request({ attachments, model: "openai/gpt-5.6-luna" }));
    expect(withImage.messages.at(-1)?.content).toContainEqual({
      type: "image",
      mediaType: "image/jpeg",
      data: "/9j/AAAA",
    });
    expect(withImage.estimatedTokens).toBeGreaterThan(plain.estimatedTokens + 2_200);
  });

  it("preserves references when a session is replayed", async () => {
    const engine = new NapContextEngine();
    const history = [event("user.message", 1, { text: "Use this reference", attachments })];
    const result = await engine.build(request({ history, model: "openai/gpt-5.6-luna" }));
    expect(result.messages[0]?.content).toContainEqual({
      type: "image",
      mediaType: "image/jpeg",
      data: "/9j/AAAA",
    });
  });

  it("refuses a budget too small for the images instead of silently dropping them", async () => {
    const engine = new NapContextEngine({ budgetTokens: MIN_BUDGET_TOKENS });
    await expect(
      engine.build(request({ attachments, model: "openai/gpt-5.6-luna" })),
    ).rejects.toThrow("Attachments exceed the context budget");
  });

  it.each([undefined, "custom/unknown-model", "nvidia/nemotron-3-ultra-550b-a55b:free"])(
    "refuses current references when image input is not established for %s",
    async (model) => {
      await expect(new NapContextEngine().build(request({ attachments, model }))).rejects.toThrow(
        "This model cannot use image or video references",
      );
    },
  );
});

it.each([MIN_BUDGET_TOKENS, 4000, DEFAULT_BUDGET_TOKENS])(
  "does not replay computer frames from a checkpoint at budget %s",
  async (budgetTokens) => {
    const checkpoint = event("compaction.completed", 1, {
      id: turnId(1),
      result: {
        kind: "api",
        checkpoint: {
          coveredThrough: 0,
          summary: "Prior work",
          tail: [
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
                  content: [{ type: "image", mediaType: "image/jpeg", data: "checkpoint-frame" }],
                },
              ],
            },
          ],
        },
      },
      usage: null,
      beforeTokens: null,
      afterTokens: null,
    });
    const built = await new NapContextEngine({ budgetTokens, verbatimTurns: 10 }).build(
      request({ model: "anthropic/claude-sonnet-5", history: [checkpoint] }),
    );
    expect(JSON.stringify(built.messages)).not.toContain("checkpoint-frame");
    expect(toolUses(built.messages).map((block) => block.id)).toEqual(
      toolResults(built.messages).map((block) => block.toolCallId),
    );
    if (budgetTokens === DEFAULT_BUDGET_TOKENS) {
      expect(toolResults(built.messages)).toHaveLength(1);
      expect(JSON.stringify(built.messages)).toContain("Earlier computer screenshot omitted");
    }
  },
);

describe("the compaction history pointer", () => {
  const HISTORY = "/home/user/.nap/history/session.txt";
  const compacted = (): NapEvent[] => {
    const before = [userMessage(1, "Keep it purple."), agentMessage(1, "Done.")];
    const checkpoint = event("compaction.completed", 1, {
      id: turnId(1),
      result: {
        kind: "api",
        checkpoint: { coveredThrough: 2, summary: "Overview: themed (#2).", tail: [] },
      },
      usage: null,
      beforeTokens: null,
      afterTokens: null,
    });
    return [...before, checkpoint];
  };
  const summaryMessage = (messages: LLMMessage[]) =>
    messages.find((message) => JSON.stringify(message).includes("Quoted session summary"));

  it("tells the agent where the replaced conversation is and how to search it", async () => {
    const built = await engine().build(request({ history: compacted(), historyFile: HISTORY }));
    const message = summaryMessage(built.messages);
    expect(message?.role).toBe("user");
    const [quoted, pointer] = texts(message ? [message] : []);
    // The pointer is the application speaking, not part of the quoted, untrusted summary.
    expect(quoted).not.toContain(HISTORY);
    expect(pointer).toContain(HISTORY);
    expect(pointer).toContain("search_files");
    expect(pointer).toContain("read_file");
    expect(pointer).toContain('"^#42 "');
  });

  it("says the file is unavailable rather than pointing at one that was not written", async () => {
    const built = await engine().build(request({ history: compacted() }));
    expect(JSON.stringify(built.messages)).not.toContain(HISTORY);
    expect(JSON.stringify(built.messages)).toContain("not available in this sandbox");
  });

  it("says nothing about a history file when nothing has been compacted", async () => {
    const built = await engine().build(
      request({ history: [userMessage(1, "hi"), agentMessage(1, "hello")], historyFile: HISTORY }),
    );
    expect(JSON.stringify(built.messages)).not.toContain(HISTORY);
    expect(JSON.stringify(built.messages)).not.toContain("history file");
  });
});

describe("steering", () => {
  const steerId = "5b0e4f7a-6a8c-4c43-9e44-2d8b3a7f0c11";

  it("renders a steer as the person's words, said while the agent worked", () => {
    const rendered = renderSteer("Use Postgres instead");
    expect(rendered).toContain("Use Postgres instead");
    // Framed, so it cannot be read as the output of the tool it follows.
    expect(rendered).not.toBe("Use Postgres instead");
  });

  it("offers the same rendering it replays history with", async () => {
    const built = await engine().build(request());
    expect(built.renderSteer).toBe(renderSteer);
  });

  it("replays an applied steer where it was read, beside the results it followed", async () => {
    const history = [
      userMessage(1, "Build a notes app"),
      toolCall(1, "toolu_1"),
      toolResult(1, "toolu_1", "listed"),
      event("steer.applied", 1, { steerId, text: "Use Postgres instead" }),
      agentMessage(1, "Switching to Postgres."),
      completed(1),
    ];
    const built = await engine().build(request({ history }));

    const answer = built.messages.find(
      (message) =>
        Array.isArray(message.content) &&
        message.content.some((block) => block.type === "tool_result"),
    );
    // One user message answers the call and carries the steer after it, exactly as the loop sent
    // it: a result and the words that followed it are never split across two messages.
    expect(answer?.role).toBe("user");
    expect(Array.isArray(answer?.content) && answer.content.map((block) => block.type)).toEqual([
      "tool_result",
      "text",
    ]);
    expect(texts(built.messages)).toContain(renderSteer("Use Postgres instead"));
  });

  it("replays neither a steer still waiting nor one that was dropped", async () => {
    const history = [
      userMessage(1, "Build a notes app"),
      event("steer.received", 1, { steerId, text: "never read" }),
      event("steer.dropped", 1, { steerId, text: "never read", reason: "stopped" }),
      agentMessage(1, "Done."),
      completed(1),
    ];
    const built = await engine().build(request({ history }));
    expect(texts(built.messages).join("\n")).not.toContain("never read");
  });

  it("carries a steer once after a compaction that kept the exchange it was read in", async () => {
    // The steer is read beside the results of the newest exchange, which is the one a compaction
    // keeps word for word; it is also among the requests every rebuild protects. Once is enough.
    const before = [
      userMessage(1, "Build a notes app"),
      toolCall(1, "toolu_1"),
      toolResult(1, "toolu_1", "listed"),
      event("steer.applied", 1, { steerId, text: "Use Postgres instead" }),
    ];
    const plan = prepareCompaction(before, 10_000);
    if (plan === null) throw new Error("nothing to compact");
    const history = [
      ...before,
      event("compaction.completed", 1, {
        id: turnId(1),
        result: {
          kind: "api",
          checkpoint: { coveredThrough: plan.coveredThrough, summary: "s", tail: plan.tail },
        },
        usage: null,
        beforeTokens: null,
        afterTokens: null,
      }),
    ];

    const built = await engine().build(request({ history }));

    const said = JSON.stringify(built.messages).split(
      JSON.stringify(renderSteer("Use Postgres instead")).slice(1, -1),
    );
    expect(said).toHaveLength(2);
    // And the exchange it kept is still whole: the call and its result, nothing else.
    expect(toolResults(built.messages).map((result) => result.toolCallId)).toEqual(["toolu_1"]);
  });

  it.each(["window", "budget"] as const)(
    "keeps a steer's words after %s eviction, as it keeps a prompt's",
    async (eviction) => {
      const history = [
        userMessage(1, "Build a notes app"),
        event("steer.applied", 1, { steerId, text: "Never use SQLite." }),
        // Larger than the budget case's whole budget, so that case really evicts the turn.
        agentMessage(1, "w".repeat(20_000)),
        completed(1),
        userMessage(2, "Add tags."),
        agentMessage(2, "OK"),
        completed(2),
      ];
      const built = await new NapContextEngine({
        maxTurns: eviction === "window" ? 1 : 20,
        budgetTokens: eviction === "budget" ? 4_000 : 80_000,
      }).build(request({ history }));
      const userText = texts(built.messages.filter((message) => message.role === "user")).join(
        "\n",
      );
      expect(userText.split("Never use SQLite.")).toHaveLength(2);
    },
  );
});
