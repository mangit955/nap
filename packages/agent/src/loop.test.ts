import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { NapEventSchema, type NapEventType } from "@nap/shared/events";
import type { AgentTurnRequest } from "@nap/shared/ports/agent-service";
import type { PendingEvent } from "@nap/shared/ports/event-store";
import type { LLMContentBlock, LLMMessage, LLMToolCall } from "@nap/shared/ports/llm-provider";
import { beforeEach, describe, expect, it } from "vitest";
import { NapAgentService } from "./agent-service.ts";
import type { TurnHook } from "./hooks/hook.ts";
import { STALE_PLAN_STEPS } from "./hooks/plan-tracking.ts";
import { ScriptedLLMProvider, type ScriptedTurn } from "./testing/scripted-llm-provider.ts";
import { PROJECT_ROOT } from "./tools/definitions.ts";

/**
 * What the loop does around its tools: which calls run together, how it recovers, when it lets a
 * turn end, and what a hook may and may not change. Asserted on events, ordering and the traffic
 * the provider saw — never on what a model said.
 */

const SESSION_ID = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";
const TURN_ID = "7c9b1a52-8d3e-4f21-a0c4-1b2d3e4f5a6b";
const APP = `${PROJECT_ROOT}/src/App.tsx`;
const OTHER = `${PROJECT_ROOT}/src/Other.tsx`;

let manager: InMemorySandboxManager;
let sandboxId: string;
let events: PendingEvent[];

beforeEach(async () => {
  manager = new InMemorySandboxManager();
  const created = await manager.create("project");
  if (!created.ok) throw new Error(created.error.message);
  sandboxId = created.value.id;
  events = [];
  await manager.writeFile(sandboxId, APP, "app\n");
  await manager.writeFile(sandboxId, OTHER, "other\n");
});

function request(overrides: Partial<AgentTurnRequest> = {}): AgentTurnRequest {
  return {
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    sandboxId,
    sandbox: manager,
    context: {
      systemPrompt: "You edit a React app.",
      messages: [{ role: "user", content: "Make it better." }],
      estimatedTokens: 10,
    },
    onEvent: (event) => events.push(event),
    ...overrides,
  };
}

function call(name: string, input: Record<string, unknown>, id: string): LLMToolCall {
  return { id, name, input };
}

function types(): NapEventType[] {
  return events.map((event) => event.type);
}

function payloads<T extends NapEventType>(type: T): unknown[] {
  return events.filter((event) => event.type === type).map((event) => event.payload);
}

function textOf(message: LLMMessage | undefined): string {
  if (message === undefined) return "";
  return typeof message.content === "string"
    ? message.content
    : message.content
        .map((block: LLMContentBlock) => (block.type === "text" ? block.text : ""))
        .join("\n");
}

function run(
  turns: ScriptedTurn[],
  options: Partial<ConstructorParameters<typeof NapAgentService>[0]> = {},
) {
  const provider = new ScriptedLLMProvider(turns);
  return { provider, agent: new NapAgentService({ provider, retryDelayMs: 0, ...options }) };
}

describe("a batch of tool calls", () => {
  it("runs consecutive reads at the same time, and writes the log as if they had not", async () => {
    // Each of the three calls waits until all three have started. One at a time, the first
    // would wait forever and the test would time out; together, all three start and finish.
    const waiting = new Set<string>();
    let release: () => void = () => {};
    const allStarted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const arrive = async (what: string) => {
      waiting.add(what);
      if (waiting.size === 3) release();
      await allStarted;
    };
    const read = manager.readFile.bind(manager);
    manager.readFile = async (id, path) => {
      // The rules lookup reads too; only the calls themselves are gated.
      if (path === APP || path === OTHER) await arrive(path);
      return read(id, path);
    };
    const list = manager.listFiles.bind(manager);
    manager.listFiles = async (id, path) => {
      await arrive("list");
      return list(id, path);
    };
    const { agent } = run([
      [
        {
          toolCalls: [
            call("read_file", { path: APP }, "a"),
            call("list_files", { path: PROJECT_ROOT }, "b"),
            call("read_file", { path: OTHER }, "c"),
          ],
        },
        { text: "Read." },
      ],
    ]);

    await agent.runTurn(request());

    const tools = events.filter(
      (event) => event.type === "tool.call" || event.type === "tool.result",
    );
    expect(
      tools.map((event) => `${event.type}:${(event.payload as { toolCallId: string }).toolCallId}`),
    ).toEqual([
      "tool.call:a",
      "tool.result:a",
      "tool.call:b",
      "tool.result:b",
      "tool.call:c",
      "tool.result:c",
    ]);
    expect(types().at(-1)).toBe("turn.completed");
  });

  it("runs a write alone, after the reads before it and before the reads after it", async () => {
    const order: string[] = [];
    const write = manager.writeFile.bind(manager);
    manager.writeFile = async (id, path, contents) => {
      order.push(`write ${path}`);
      return write(id, path, contents);
    };
    const read = manager.readFile.bind(manager);
    manager.readFile = async (id, path) => {
      if (!path.endsWith(".md")) order.push(`read ${path}`);
      return read(id, path);
    };
    const { agent } = run([
      [
        {
          toolCalls: [
            call("read_file", { path: APP }, "a"),
            call("write_file", { path: APP, contents: "new\n" }, "b"),
            call("read_file", { path: APP }, "c"),
          ],
        },
        { text: "Done." },
      ],
    ]);

    await agent.runTurn(request());

    expect(order).toEqual([`read ${APP}`, `read ${APP}`, `write ${APP}`, `read ${APP}`]);
  });

  it("answers every call of a batch in one message, in the order they were asked", async () => {
    const { agent, provider } = run([
      [
        {
          toolCalls: [
            call("read_file", { path: APP }, "a"),
            call("read_file", { path: `${PROJECT_ROOT}/missing` }, "b"),
            call("glob", { pattern: "*.tsx" }, "c"),
          ],
        },
        { text: "Done." },
      ],
    ]);
    manager.script(/^cd .* && find /, { stdout: "./src/App.tsx\n" });

    await agent.runTurn(request());

    const last = provider.requests[1]?.messages.at(-1);
    expect(
      Array.isArray(last?.content) &&
        last.content.map((block) => block.type === "tool_result" && block.toolCallId),
    ).toEqual(["a", "b", "c"]);
  });
});

describe("recovering", () => {
  it("asks for the rest of a reply cut off at the output limit, a bounded number of times", async () => {
    const { agent, provider } = run([
      [
        { text: "Here is the first half", truncated: true },
        { text: "and still more", truncated: true },
        { text: "and more again", truncated: true },
      ],
    ]);

    await agent.runTurn(request());

    expect(provider.requests).toHaveLength(3);
    expect(textOf(provider.requests[1]?.messages.at(-1))).toMatch(/cut off at the output limit/);
    expect(types().at(-1)).toBe("turn.completed");
  });

  it("continues on the fallback model after a refusal, and says so", async () => {
    const { agent, provider } = run([[{ refusal: true }], [{ text: "Happy to." }]], {
      fallbackModel: "openai/gpt-5.6-luna",
    });

    await agent.runTurn(request({ model: "anthropic/claude-opus-5" }));

    expect(provider.turnOptions.map((options) => options.model)).toEqual([
      "anthropic/claude-opus-5",
      "openai/gpt-5.6-luna",
    ]);
    expect(types()).toEqual(["turn.started", "system.notice", "agent.message", "turn.completed"]);
  });

  it("never moves a person's own key to a model they did not choose", async () => {
    const { agent, provider } = run([[{ refusal: true }]], {
      fallbackModel: "openai/gpt-5.6-luna",
    });

    await agent.runTurn(
      request({
        model: "anthropic/claude-opus-5",
        credentials: { platform: "anthropic", apiKey: "sk-test" },
      }),
    );

    expect(provider.turnOptions).toHaveLength(1);
    expect(payloads("turn.failed")).toEqual([expect.objectContaining({ reason: "refusal" })]);
  });

  it("bills the refused model and the fallback both", async () => {
    const { agent } = run(
      [
        [{ refusal: true, usage: { inputTokens: 100, outputTokens: 1 } }],
        [{ text: "ok", usage: { inputTokens: 50, outputTokens: 5 } }],
      ],
      { fallbackModel: "openai/gpt-5.6-luna" },
    );

    await agent.runTurn(request({ model: "anthropic/claude-opus-5" }));

    expect(payloads("turn.completed")).toEqual([
      expect.objectContaining({ usage: { inputTokens: 150, outputTokens: 6 } }),
    ]);
  });
});

describe("ending a turn", () => {
  const PLAN = [
    { content: "Build it", status: "completed" },
    { content: "Style it", status: "in_progress" },
  ];

  it("asks once about unfinished plan items, then lets the turn end", async () => {
    const { agent, provider } = run([
      [
        { toolCalls: [call("todo_write", { todos: PLAN }, "plan")] },
        { text: "Done." },
        { text: "Styling is out of scope today." },
      ],
    ]);

    await agent.runTurn(request());

    expect(provider.requests).toHaveLength(3);
    expect(textOf(provider.requests[2]?.messages.at(-1))).toMatch(/1 unfinished item: "Style it"/);
    expect(types().at(-1)).toBe("turn.completed");
  });

  it("does not object when the plan is finished", async () => {
    const { agent, provider } = run([
      [
        {
          toolCalls: [
            call(
              "todo_write",
              { todos: PLAN.map((item) => ({ ...item, status: "completed" })) },
              "plan",
            ),
          ],
        },
        { text: "Done." },
      ],
    ]);

    await agent.runTurn(request());

    expect(provider.requests).toHaveLength(2);
  });

  it("reminds the model of a plan it has stopped updating", async () => {
    const reads = Array.from({ length: STALE_PLAN_STEPS }, (_, i) => ({
      toolCalls: [call("read_file", { path: APP }, `r${i}`)],
    }));
    const { agent, provider } = run([
      [
        { toolCalls: [call("todo_write", { todos: PLAN }, "plan")] },
        ...reads,
        {
          toolCalls: [
            call(
              "todo_write",
              { todos: PLAN.map((item) => ({ ...item, status: "completed" })) },
              "done",
            ),
          ],
        },
        { text: "Done." },
      ],
    ]);

    await agent.runTurn(request());

    const reminded = provider.requests.findIndex((sent) =>
      textOf(sent.messages.at(-1)).includes("Your plan has not changed"),
    );
    // The update was the first request; the reminder rides on the request that many after it.
    expect(reminded).toBe(STALE_PLAN_STEPS);
    expect(
      provider.requests.filter((sent) =>
        textOf(sent.messages.at(-1)).includes("Your plan has not changed"),
      ),
    ).toHaveLength(1);
  });

  it("ends the turn at a question, after answering the whole batch", async () => {
    const { agent, provider } = run([
      [
        {
          toolCalls: [
            call("read_file", { path: APP }, "read"),
            call(
              "ask_user",
              {
                question: "Grid or list?",
                options: [
                  { label: "Grid", description: null },
                  { label: "List", description: null },
                ],
                multiSelect: false,
              },
              "ask",
            ),
          ],
        },
      ],
    ]);

    await agent.runTurn(request());

    expect(provider.requests).toHaveLength(1);
    expect(types().filter((type) => type !== "tool.call" && type !== "tool.result")).toEqual([
      "turn.started",
      "agent.question",
      "turn.completed",
    ]);
  });

  it("lets a stop hook delay the end at most twice", async () => {
    const stubborn: TurnHook = { beforeStop: async () => "Not yet." };
    const { agent, provider } = run([[{ text: "1" }, { text: "2" }, { text: "3" }]], {
      hooks: () => [stubborn],
    });

    await agent.runTurn(request());

    expect(provider.requests).toHaveLength(3);
    expect(types().at(-1)).toBe("turn.completed");
  });
});

describe("hooks", () => {
  it("can add to what a tool said but never turn a failure into a success", async () => {
    const liar: TurnHook = {
      afterTool: async (_call, outcome) => ({ ok: true, output: `${outcome.output} [checked]` }),
    };
    const { agent, provider } = run(
      [
        [
          { toolCalls: [call("read_file", { path: `${PROJECT_ROOT}/missing` }, "a")] },
          { text: "ok" },
        ],
      ],
      { hooks: () => [liar] },
    );

    await agent.runTurn(request());

    const result = provider.requests[1]?.messages.at(-1)?.content;
    expect(Array.isArray(result) && result[0]).toEqual(
      expect.objectContaining({ isError: true, content: expect.stringMatching(/\[checked\]$/) }),
    );
  });

  it("puts reminders after the tool results, in the same message", async () => {
    const reminder: TurnHook = {
      beforeModel: (step) => (step === 2 ? "Mind the budget." : undefined),
    };
    const { agent, provider } = run(
      [[{ toolCalls: [call("read_file", { path: APP }, "a")] }, { text: "ok" }]],
      { hooks: () => [reminder] },
    );

    await agent.runTurn(request());

    const last = provider.requests[1]?.messages.at(-1);
    expect(Array.isArray(last?.content) && last.content.map((block) => block.type)).toEqual([
      "tool_result",
      "text",
    ]);
    expect(Array.isArray(last?.content) && last.content.at(-1)).toEqual({
      type: "text",
      text: "<reminder>Mind the budget.</reminder>",
    });
  });
});

describe("a project's rules for a directory", () => {
  it("arrive with the first result that touches the directory, and only then", async () => {
    await manager.writeFile(
      sandboxId,
      `${PROJECT_ROOT}/src/AGENTS.md`,
      "Components are named exports.\n",
    );
    await manager.writeFile(sandboxId, `${PROJECT_ROOT}/AGENTS.md`, "Root brief.\n");
    const { agent, provider } = run([
      [
        { toolCalls: [call("read_file", { path: APP }, "a")] },
        { toolCalls: [call("read_file", { path: OTHER }, "b")] },
        { text: "ok" },
      ],
    ]);

    await agent.runTurn(request());

    const first = textOfResult(provider.requests[1]?.messages.at(-1));
    const second = textOfResult(provider.requests[2]?.messages.at(-1));
    expect(first).toContain(
      `<project-rules path="${PROJECT_ROOT}/src/AGENTS.md">\nComponents are named exports.\n</project-rules>`,
    );
    // The root brief of a Nap project is in the system prompt already.
    expect(first).not.toContain("Root brief.");
    expect(second).not.toContain("project-rules");
  });

  it("include the root's for an imported repository", async () => {
    await manager.writeFile(sandboxId, `${PROJECT_ROOT}/AGENTS.md`, "Use pnpm.\n");
    const { agent, provider } = run([
      [{ toolCalls: [call("read_file", { path: APP }, "a")] }, { text: "ok" }],
    ]);

    await agent.runTurn(
      request({
        context: {
          systemPrompt: "repo",
          messages: [{ role: "user", content: "go" }],
          estimatedTokens: 1,
          rootRules: true,
        },
      }),
    );

    expect(textOfResult(provider.requests[1]?.messages.at(-1))).toContain("Use pnpm.");
  });
});

describe("helpers", () => {
  const PROMPTS = { explore: "You search.", general: "You build." };

  function withHelpers(overrides: Partial<AgentTurnRequest> = {}) {
    return request({
      context: {
        systemPrompt: "parent",
        messages: [{ role: "user", content: "Where are routes declared?" }],
        estimatedTokens: 10,
        subagentPrompts: PROMPTS,
      },
      ...overrides,
    });
  }

  it("runs a helper on its own conversation and hands back its report, not its traffic", async () => {
    const { agent, provider } = run(
      [
        [
          {
            toolCalls: [
              call("run_subagent", { profile: "explore", task: "Find the routes." }, "sub"),
            ],
          },
          { text: "They are in App.tsx." },
        ],
        [
          {
            toolCalls: [call("read_file", { path: APP }, "inner")],
            usage: { inputTokens: 30, outputTokens: 3 },
          },
          { text: "src/App.tsx:1", usage: { inputTokens: 40, outputTokens: 4 } },
        ],
      ],
      { subagentModels: { explore: "openai/gpt-5.6-luna" } },
    );

    await agent.runTurn(withHelpers({ model: "anthropic/claude-opus-5" }));

    expect(provider.turnOptions.map((options) => options.model)).toEqual([
      "anthropic/claude-opus-5",
      "openai/gpt-5.6-luna",
    ]);
    // The helper saw its task and its own prompt, and none of the parent's conversation.
    const helperFirst = provider.requests[1];
    expect(helperFirst?.systemPrompt).toBe("You search.");
    expect(helperFirst?.messages).toEqual([{ role: "user", content: "Find the routes." }]);
    expect(helperFirst?.tools.map((tool) => tool.name)).toEqual([
      "read_file",
      "list_files",
      "search_files",
      "glob",
    ]);

    expect(types()).toEqual([
      "turn.started",
      "tool.call",
      "subagent.started",
      "subagent.completed",
      "tool.result",
      "agent.message",
      "turn.completed",
    ]);
    expect(payloads("tool.call")).toEqual([expect.objectContaining({ toolCallId: "sub" })]);
    expect(payloads("subagent.completed")).toEqual([
      {
        subagentId: "helper-1",
        outcome: "completed",
        summary: "src/App.tsx:1",
        toolCalls: 1,
        usage: { inputTokens: 70, outputTokens: 7 },
      },
    ]);
    expect(payloads("turn.completed")).toEqual([
      expect.objectContaining({ usage: { inputTokens: 70, outputTokens: 7 } }),
    ]);
    for (const [seq, event] of events.entries())
      expect(NapEventSchema.safeParse({ ...event, seq }).success).toBe(true);
  });

  it("runs on the turn's own model when the person is paying", async () => {
    const { agent, provider } = run(
      [
        [
          { toolCalls: [call("run_subagent", { profile: "explore", task: "Look." }, "sub")] },
          { text: "ok" },
        ],
        [{ text: "found" }],
      ],
      { subagentModels: { explore: "openai/gpt-5.6-luna" } },
    );

    await agent.runTurn(
      withHelpers({
        model: "anthropic/claude-opus-5",
        credentials: { platform: "anthropic", apiKey: "k" },
      }),
    );

    expect(provider.turnOptions.map((options) => options.model)).toEqual([
      "anthropic/claude-opus-5",
      "anthropic/claude-opus-5",
    ]);
  });

  it("lets a general helper's file changes into the log", async () => {
    const { agent } = run([
      [
        { toolCalls: [call("run_subagent", { profile: "general", task: "Add a file." }, "sub")] },
        { text: "ok" },
      ],
      [
        {
          toolCalls: [call("write_file", { path: `${PROJECT_ROOT}/new.ts`, contents: "x\n" }, "w")],
        },
        { text: "Added." },
      ],
    ]);

    await agent.runTurn(withHelpers());

    expect(types()).toContain("file.changed");
    expect(payloads("tool.call")).toHaveLength(1);
  });

  it("asks for a background helper's report before the turn ends, and stops one never collected", async () => {
    let releaseHelper: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      releaseHelper = resolve;
    });
    const { agent, provider } = run([
      [
        {
          toolCalls: [
            call("run_subagent", { profile: "explore", task: "Slow.", background: true }, "sub"),
          ],
        },
        { text: "Done." },
        { text: "Still done." },
      ],
      [{ text: "never seen" }],
    ]);
    const complete = provider.startTurn.bind(provider);
    let turns = 0;
    provider.startTurn = (options) => {
      const turn = complete(options);
      turns += 1;
      if (turns === 2) {
        const inner = turn.complete.bind(turn);
        turn.complete = async (sent) => {
          await new Promise<void>((resolve) =>
            sent.signal?.addEventListener("abort", () => resolve()),
          );
          releaseHelper();
          return inner(sent);
        };
      }
      return turn;
    };

    await agent.runTurn(withHelpers());
    await held;

    const objection = provider.requests.find((sent) =>
      textOf(sent.messages.at(-1)).includes("still working"),
    );
    expect(objection).toBeDefined();
    expect(payloads("subagent.completed")).toEqual([
      expect.objectContaining({ subagentId: "helper-1", outcome: "cancelled" }),
    ]);
    // The helper was stopped before the turn reported itself complete.
    expect(types().indexOf("subagent.completed")).toBeLessThan(types().indexOf("turn.completed"));
  });

  it("is not offered without prompts to run helpers under", async () => {
    const { agent, provider } = run([[{ text: "ok" }]]);
    await agent.runTurn(request());
    expect(provider.requests[0]?.tools.map((tool) => tool.name)).not.toContain("run_subagent");
  });
});

function textOfResult(message: LLMMessage | undefined): string {
  if (message === undefined || typeof message.content === "string") return "";
  return message.content
    .map((block) =>
      block.type === "tool_result" && typeof block.content === "string" ? block.content : "",
    )
    .join("\n");
}
