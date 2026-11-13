import { NapContextEngine, STALE_TOOL_OUTPUT } from "@nap/context/context-engine";
import { NoopMemoryProvider } from "@nap/context/noop-memory-provider";
import { stubSandbox } from "@nap/context/testing/stub-sandbox";
import { E2BSandboxDesktop } from "@nap/sandbox/e2b-sandbox-desktop";
import { FakeSandboxDesktop } from "@nap/sandbox/testing/fake-sandbox-desktop";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { isolatedDesktop } from "@nap/sandbox/testing/isolated-desktop";
import { type NapEvent, NapEventSchema, type NapEventType } from "@nap/shared/events";
import type { AgentTurnRequest } from "@nap/shared/ports/agent-service";
import type { PendingEvent } from "@nap/shared/ports/event-store";
import type { LLMContentBlock, LLMMessage, LLMToolCall } from "@nap/shared/ports/llm-provider";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
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
  it.each(["reference", "screenshot"] as const)(
    "refuses a text-only fallback while retained %s pixels are needed",
    async (source) => {
      const { agent, provider } = run(
        [
          [
            ...(source === "screenshot"
              ? [
                  {
                    toolCalls: [
                      call("computer", { actions: [{ action: "screenshot" }] }, "screen"),
                    ],
                  },
                ]
              : []),
            { refusal: true },
          ],
          [{ text: "must not continue without the image" }],
        ],
        { fallbackModel: "poolside/laguna-s-2.1:free" },
      );
      const desktop = new FakeSandboxDesktop({
        bytes: new Uint8Array([255, 216, 255, 217]),
        width: 1024,
        height: 768,
      });
      await agent.runTurn(
        request({
          model: "openai/gpt-5.6-luna",
          context: {
            systemPrompt: "Build from the visual evidence.",
            estimatedTokens: 2_500,
            messages: [
              {
                role: "user",
                content:
                  source === "reference"
                    ? [
                        { type: "text", text: "Build this reference." },
                        { type: "image", mediaType: "image/jpeg", data: "AA==" },
                      ]
                    : "Inspect the screen.",
              },
            ],
          },
          computer: {
            desktop,
            objects: new InMemoryObjectStore(),
            projectId: "project",
            devServerUrl: "http://localhost:5173",
            beforeStore: async () => {},
          },
        }),
      );

      // Establish that pixels reached the refusing request, including nested screenshots.
      const refusing = provider.requests[source === "reference" ? 0 : 1];
      expect(refusing).toBeDefined();
      expect(
        refusing?.messages.flatMap((message) =>
          typeof message.content === "string"
            ? []
            : message.content.flatMap((block) =>
                block.type === "image"
                  ? [block]
                  : block.type === "tool_result" && Array.isArray(block.content)
                    ? block.content.filter((observation) => observation.type === "image")
                    : [],
              ),
        ),
      ).toHaveLength(1);
      expect(provider.turnOptions.map((options) => options.model)).toEqual(["openai/gpt-5.6-luna"]);
      expect(provider.requests).toHaveLength(source === "reference" ? 1 : 2);
      expect(payloads("turn.failed")).toEqual([expect.objectContaining({ reason: "refusal" })]);
      expect(types()).not.toContain("turn.completed");
      expect(payloads("system.notice")).not.toContainEqual(
        expect.objectContaining({ text: expect.stringMatching(/is continuing it/) }),
      );
    },
  );

  it("preserves the reference when falling back to another image model", async () => {
    const image = { type: "image", mediaType: "image/jpeg", data: "AA==" } as const;
    const { agent, provider } = run([[{ refusal: true }], [{ text: "done" }]], {
      fallbackModel: "anthropic/claude-opus-5",
    });
    await agent.runTurn(
      request({
        model: "openai/gpt-5.6-luna",
        context: {
          systemPrompt: "Build this.",
          estimatedTokens: 2_500,
          messages: [{ role: "user", content: [image] }],
        },
      }),
    );
    expect(provider.turnOptions.map((options) => options.model)).toEqual([
      "openai/gpt-5.6-luna",
      "anthropic/claude-opus-5",
    ]);
    expect(provider.requests[1]?.messages[0]?.content).toContainEqual(image);
    expect(types().at(-1)).toBe("turn.completed");
  });

  it("allows a text-only fallback for a conversation without images", async () => {
    const { agent, provider } = run([[{ refusal: true }], [{ text: "done" }]], {
      fallbackModel: "poolside/laguna-s-2.1:free",
    });
    await agent.runTurn(request({ model: "openai/gpt-5.6-luna" }));
    expect(provider.turnOptions.map((options) => options.model)).toEqual([
      "openai/gpt-5.6-luna",
      "poolside/laguna-s-2.1:free",
    ]);
    expect(types().at(-1)).toBe("turn.completed");
  });

  it.each([
    ["openai/gpt-5.6-luna", "anthropic/claude-fable-5", false],
    ["anthropic/claude-fable-5", "openai/gpt-5.6-luna", true],
  ])(
    "selects computer availability again when %s falls back to %s",
    async (model, fallbackModel, computer) => {
      const { agent, provider } = run([[{ refusal: true }], [{ text: "done" }]], { fallbackModel });

      await agent.runTurn(
        request({
          model,
          computer: {
            desktop: isolatedDesktop(new E2BSandboxDesktop({ sandbox: manager })),
            objects: new InMemoryObjectStore(),
            projectId: "project",
            devServerUrl: "http://localhost:5173",
            beforeStore: async () => {},
          },
        }),
      );

      expect(provider.requests[1]?.tools.some((tool) => tool.name === "computer")).toBe(computer);
    },
  );

  it.each([
    ["openai/gpt-5.6-luna", "anthropic/claude-opus-5", false],
    ["anthropic/claude-opus-5", "openai/gpt-5.6-luna", true],
  ])("selects tools again when %s falls back to %s", async (model, fallbackModel, patch) => {
    const { agent, provider } = run([[{ refusal: true }], [{ text: "done" }]], { fallbackModel });

    await agent.runTurn(request({ model }));

    expect(provider.requests[1]?.tools.some((tool) => tool.name === "apply_patch")).toBe(patch);
  });

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

  /** Everything the log says the model wrote, joined the way the transcript joins it. */
  function written(): string {
    return payloads("agent.message")
      .map((payload) => (payload as { text: string }).text)
      .join("");
  }

  it("asks for the rest of a reply a failed stream had already shown, never the whole of it again", async () => {
    const { agent, provider } = run([
      [
        {
          streamedText: ["Here is the plan. "],
          error: { message: "socket hang up", retryable: true },
        },
        { streamedText: ["Step one is the header."], text: "Step one is the header." },
      ],
    ]);

    await agent.runTurn(request());

    expect(written()).toBe("Here is the plan. Step one is the header.");
    const retried = provider.requests[1]?.messages ?? [];
    expect(retried.at(-2)).toEqual({ role: "assistant", content: "Here is the plan. " });
    expect(textOf(retried.at(-1))).toMatch(/stopped partway/);
    expect(types().at(-1)).toBe("turn.completed");
  });

  it("asks again from the start when the failed stream had shown nothing", async () => {
    const { agent, provider } = run([
      [{ error: { message: "socket hang up", retryable: true } }, { text: "Done." }],
    ]);

    await agent.runTurn(request());

    expect(provider.requests[1]?.messages).toEqual(provider.requests[0]?.messages);
  });

  it("hands the fallback the part of a refused reply that was already shown", async () => {
    const { agent, provider } = run(
      [
        [{ streamedText: ["Sure, "], refusal: true }],
        [{ streamedText: ["here it is."], text: "here it is." }],
      ],
      { fallbackModel: "openai/gpt-5.6-luna" },
    );

    await agent.runTurn(request({ model: "anthropic/claude-opus-5" }));

    expect(written()).toBe("Sure, here it is.");
    expect(provider.requests[1]?.messages.at(-2)).toEqual({ role: "assistant", content: "Sure, " });
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

  it("refuses a question on a repair turn at once, though the tool is declared", async () => {
    // A repair declares the person's tool set so the cached prefix survives it; nobody is
    // watching, so the call must come straight back refused rather than ask and wait.
    const QUESTION = {
      question: "Grid or list?",
      options: [
        { label: "Grid", description: null },
        { label: "List", description: null },
      ],
      multiSelect: false,
    };
    const { agent, provider } = run([
      [{ toolCalls: [call("ask_user", QUESTION, "ask")] }, { text: "Fixed it." }],
    ]);

    await agent.runTurn(request({ promptSource: "verification" }));

    expect(provider.requests[0]?.tools.map((tool) => tool.name)).toContain("ask_user");
    expect(types()).not.toContain("agent.question");
    expect(provider.requests).toHaveLength(2);
    // Told that nobody will answer, not merely that the tool is missing — which invites another
    // way of asking rather than a decision.
    const answered = provider.requests[1]?.messages.at(-1);
    expect(JSON.stringify(answered)).toContain("Nobody can answer a question from here");
    expect(JSON.stringify(answered)).toContain("continue");
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

  it("gives helpers directory rules in their own conversation", async () => {
    await manager.writeFile(sandboxId, `${PROJECT_ROOT}/AGENTS.md`, "Use pnpm.");
    await manager.writeFile(sandboxId, `${PROJECT_ROOT}/src/AGENTS.md`, "Use named exports.");
    const { agent, provider } = run([
      [
        { toolCalls: [call("run_subagent", { profile: "general", task: "Read the app." }, "sub")] },
        { text: "done" },
      ],
      [{ toolCalls: [call("read_file", { path: APP }, "inner")] }, { text: "report" }],
    ]);
    const sent = withHelpers();
    sent.context.rootRules = true;

    await agent.runTurn(sent);

    const helperResult = textOfResult(provider.requests[2]?.messages.at(-1));
    expect(helperResult).toContain("Use pnpm.");
    expect(helperResult).toContain("Use named exports.");
  });

  it("refuses helper background commands before starting a shell", async () => {
    const { agent, provider } = run([
      [
        { toolCalls: [call("run_subagent", { profile: "general", task: "Build." }, "sub")] },
        { text: "done" },
      ],
      [
        {
          toolCalls: [
            call(
              "run_command",
              { command: "sleep 1; echo late > result.txt", background: true },
              "cmd",
            ),
          ],
        },
        { text: "report" },
      ],
    ]);

    await agent.runTurn(withHelpers());

    expect(manager.commands(sandboxId)).toEqual([]);
    const helperResult = provider.requests[2]?.messages.at(-1)?.content;
    expect(helperResult).toEqual([
      expect.objectContaining({
        type: "tool_result",
        isError: true,
        content: expect.stringMatching(/foreground/),
      }),
    ]);
  });

  it("selects a general helper's tools using the helper's own model family", async () => {
    const { agent, provider } = run(
      [
        [
          { toolCalls: [call("run_subagent", { profile: "general", task: "Build." }, "sub")] },
          { text: "done" },
        ],
        [{ text: "report" }],
      ],
      { subagentModels: { general: "openai/gpt-5.6-luna" } },
    );

    await agent.runTurn(withHelpers({ model: "anthropic/claude-opus-5" }));

    expect(provider.requests[1]?.tools.some((tool) => tool.name === "apply_patch")).toBe(true);
  });

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

  it("keeps foreground helper events inside its ordered tool exchange in a parallel batch", async () => {
    const { agent } = run([
      [
        {
          toolCalls: [
            call("read_file", { path: APP }, "read"),
            call("run_subagent", { profile: "explore", task: "Find routes." }, "sub"),
          ],
        },
        { text: "done" },
      ],
      [{ text: "report" }],
    ]);

    await agent.runTurn(withHelpers());

    expect(types()).toEqual([
      "turn.started",
      "tool.call",
      "tool.result",
      "tool.call",
      "subagent.started",
      "subagent.completed",
      "tool.result",
      "agent.message",
      "turn.completed",
    ]);
  });

  it.each(["refusal", "error"] as const)(
    "settles background helpers before a parent %s ends the turn",
    async (failure) => {
      const { agent, provider } = run([
        [
          {
            toolCalls: [
              call("run_subagent", { profile: "explore", task: "Wait.", background: true }, "sub"),
            ],
          },
          failure === "refusal"
            ? { refusal: true }
            : { error: { message: "Unavailable", retryable: false } },
        ],
        [{ text: "never" }],
      ]);
      const start = provider.startTurn.bind(provider);
      let helperSignal: AbortSignal | undefined;
      provider.startTurn = (options) => {
        const turn = start(options);
        if (provider.turnOptions.length === 2)
          turn.complete = (sent) => {
            helperSignal = sent.signal;
            return new Promise(() => {});
          };
        return turn;
      };

      await agent.runTurn(withHelpers());
      const atReturn = [...events];
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(helperSignal?.aborted).toBe(true);
      expect(types().at(-1)).toBe("turn.failed");
      expect(payloads("subagent.completed")).toEqual([
        expect.objectContaining({ outcome: "cancelled" }),
      ]);
      expect(events).toEqual(atReturn);
    },
  );

  it("stops background helpers even when the parent's provider throws", async () => {
    const { agent, provider } = run([
      [
        {
          toolCalls: [
            call("run_subagent", { profile: "explore", task: "Wait.", background: true }, "sub"),
          ],
        },
      ],
      [{ text: "never" }],
    ]);
    const start = provider.startTurn.bind(provider);
    let helperSignal: AbortSignal | undefined;
    provider.startTurn = (options) => {
      const turn = start(options);
      if (provider.turnOptions.length === 1) {
        const complete = turn.complete.bind(turn);
        let calls = 0;
        turn.complete = (sent) => {
          if (calls++ === 0) return complete(sent);
          return Promise.reject(new Error("Connection lost"));
        };
      } else
        turn.complete = (sent) => {
          helperSignal = sent.signal;
          return new Promise(() => {});
        };
      return turn;
    };

    await expect(agent.runTurn(withHelpers())).rejects.toThrow("Connection lost");

    expect(helperSignal?.aborted).toBe(true);
    expect(payloads("subagent.completed")).toEqual([
      expect.objectContaining({ outcome: "cancelled" }),
    ]);
  });

  it("reports a helper provider exception as a failed helper and lets the parent continue", async () => {
    const { agent, provider } = run([
      [
        { toolCalls: [call("run_subagent", { profile: "explore", task: "Search." }, "sub")] },
        { text: "done" },
      ],
      [{ text: "never" }],
    ]);
    const start = provider.startTurn.bind(provider);
    provider.startTurn = (options) => {
      const turn = start(options);
      if (provider.turnOptions.length === 2)
        turn.complete = () => Promise.reject(new Error("Connection lost"));
      return turn;
    };

    await expect(agent.runTurn(withHelpers())).resolves.toBeUndefined();

    expect(payloads("subagent.completed")).toEqual([
      expect.objectContaining({ outcome: "failed", summary: "Connection lost" }),
    ]);
    expect(types().at(-1)).toBe("turn.completed");
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

describe("a plan mode turn", () => {
  const proposal = (id = "plan") =>
    call("propose_plan", { title: "Dark theme", plan: "1. Add tokens\n2. Swap colours" }, id);

  it("offers only the tools that look, ask or propose", async () => {
    const { agent, provider } = run([[{ toolCalls: [proposal()] }]]);
    await agent.runTurn(request({ mode: "plan" }));
    const offered = provider.requests[0]?.tools.map((tool) => tool.name) ?? [];
    expect(offered).toContain("propose_plan");
    for (const name of ["write_file", "edit_file", "apply_patch", "todo_write", "shell_kill"])
      expect(offered).not.toContain(name);
  });

  it("ends on the proposal awaiting approval, and never runs the commit it was handed", async () => {
    let finalized = false;
    const { agent, provider } = run([[{ toolCalls: [proposal()] }]]);

    await agent.runTurn(
      request({
        mode: "plan",
        finalize: async () => {
          finalized = true;
          return { commitSha: "deadbeef" };
        },
      }),
    );

    expect(provider.requests).toHaveLength(1);
    expect(types().filter((type) => type !== "tool.call" && type !== "tool.result")).toEqual([
      "turn.started",
      "plan.proposed",
      "turn.completed",
    ]);
    expect(payloads("turn.completed")[0]).toMatchObject({
      commitSha: null,
      awaiting: "plan_approval",
    });
    expect(finalized).toBe(false);
    for (const event of events)
      expect(NapEventSchema.safeParse({ ...event, seq: 0 }).success).toBe(true);
  });

  it("refuses an edit the model asks for anyway, and the file is untouched", async () => {
    const { agent } = run([
      [
        { toolCalls: [call("write_file", { path: APP, contents: "changed\n" }, "w")] },
        { toolCalls: [proposal()] },
      ],
    ]);
    await agent.runTurn(request({ mode: "plan" }));
    expect(payloads("tool.result")[0]).toMatchObject({ toolName: "write_file", ok: false });
    const app = await manager.readFile(sandboxId, APP);
    expect(app.ok && app.value).toBe("app\n");
  });

  it("is reminded once to propose when it tries to stop without a plan, then may stop", async () => {
    const { agent, provider } = run([[{ text: "Looks fine." }, { text: "Nothing to change." }]]);
    await agent.runTurn(request({ mode: "plan" }));
    expect(provider.requests).toHaveLength(2);
    expect(textOf(provider.requests[1]?.messages.at(-1))).toMatch(/propose_plan/);
    expect(payloads("turn.completed")[0]).not.toHaveProperty("awaiting");
  });

  it("leaves an ordinary turn's commit and outcome as they were", async () => {
    const { agent } = run([[{ text: "Done." }]]);
    await agent.runTurn(request({ finalize: async () => ({ commitSha: "abc123" }) }));
    expect(payloads("turn.completed")[0]).toMatchObject({ commitSha: "abc123" });
    expect(payloads("turn.completed")[0]).not.toHaveProperty("awaiting");
  });
});

describe("steering", () => {
  const render = (text: string) => `[steer] ${text}`;
  /** A request with a mailbox: each `take` hands over whatever the test put there since the last. */
  function steered(overrides: Partial<AgentTurnRequest> = {}) {
    const mailbox: string[] = [];
    let takes = 0;
    const base = request();
    return {
      mailbox,
      takes: () => takes,
      request: request({
        context: { ...base.context, renderSteer: render },
        steering: {
          take: async () => {
            takes += 1;
            return mailbox.splice(0).map((text, index) => ({ id: `s${takes}-${index}`, text }));
          },
        },
        ...overrides,
      }),
    };
  }

  it("hands a steer to the model at the next step, after the results, in the same message", async () => {
    const { agent, provider } = run([
      [{ toolCalls: [call("read_file", { path: APP }, "a")] }, { text: "ok" }],
    ]);
    const turn = steered();
    const read = manager.readFile.bind(manager);
    manager.readFile = async (id, path) => {
      // Sent while the call runs; read only once its batch is answered.
      if (path === APP) turn.mailbox.push("Use Postgres instead");
      return read(id, path);
    };

    await agent.runTurn(turn.request);

    expect(textOf(provider.requests[0]?.messages.at(-1))).not.toContain("Postgres");
    const last = provider.requests[1]?.messages.at(-1);
    expect(Array.isArray(last?.content) && last.content.map((block) => block.type)).toEqual([
      "tool_result",
      "text",
    ]);
    expect(Array.isArray(last?.content) && last.content.at(-1)).toEqual({
      type: "text",
      text: "[steer] Use Postgres instead",
    });
    expect(types().filter((type) => type === "turn.completed")).toHaveLength(1);
  });

  it("keeps a turn going when a steer arrives after the model's last reply", async () => {
    const { agent, provider } = run([[{ text: "Done." }, { text: "Switched to Postgres." }]]);
    const turn = steered();
    const take = turn.request.steering?.take;
    let asked = 0;
    // Empty at the first step; there by the time the model says it is finished.
    turn.request.steering = {
      take: async () => {
        asked += 1;
        if (asked === 2) turn.mailbox.push("Use Postgres instead");
        return (await take?.()) ?? [];
      },
    };

    await agent.runTurn(turn.request);

    expect(provider.requests).toHaveLength(2);
    const [reply, steer] = provider.requests[1]?.messages.slice(-2) ?? [];
    expect(reply?.role).toBe("assistant");
    expect(textOf(reply)).toBe("Done.");
    expect(steer?.role).toBe("user");
    expect(textOf(steer)).toBe("[steer] Use Postgres instead");
    expect(types().filter((type) => type === "turn.completed")).toHaveLength(1);
  });

  it("never asks for steers while a batch is running", async () => {
    const { agent } = run([
      [
        {
          toolCalls: [
            call("read_file", { path: APP }, "a"),
            call("write_file", { path: OTHER, contents: "changed\n" }, "w"),
            call("read_file", { path: OTHER }, "b"),
          ],
        },
        { text: "ok" },
      ],
    ]);
    let running = 0;
    let askedMidBatch = false;
    for (const method of ["readFile", "writeFile"] as const) {
      const original = manager[method].bind(manager) as (...args: unknown[]) => Promise<unknown>;
      (manager as unknown as Record<string, unknown>)[method] = async (...args: unknown[]) => {
        running += 1;
        try {
          return await original(...args);
        } finally {
          running -= 1;
        }
      };
    }
    const turn = steered();
    turn.request.steering = {
      take: async () => {
        if (running > 0) askedMidBatch = true;
        return [];
      },
    };

    await agent.runTurn(turn.request);

    expect(askedMidBatch).toBe(false);
  });

  it("takes no steer it has no step left to answer", async () => {
    const { agent, provider } = run([[{ text: "Done." }]], { budget: { maxSteps: 1 } });
    const turn = steered();
    const take = turn.request.steering?.take;
    // Nothing at the first step; sent while its one model call runs, so there is no step after it.
    turn.request.steering = {
      take: async () => {
        const taken = (await take?.()) ?? [];
        turn.mailbox.push("and another");
        return taken;
      },
    };

    await agent.runTurn(turn.request);

    expect(provider.requests).toHaveLength(1);
    // Left where it was, for whoever closes the request to queue as the next turn.
    expect(turn.mailbox).toEqual(["and another"]);
    expect(types().at(-1)).toBe("turn.completed");
  });

  it("does not fail a finished turn by steering it with no room left", async () => {
    // Two steps: the model finishes on the first, the steer arrives during it, and one step is not
    // enough to answer a steer the model may well answer with a tool call.
    const { agent } = run(
      [[{ text: "Done." }, { toolCalls: [call("read_file", { path: APP }, "a")] }, { text: "x" }]],
      { budget: { maxSteps: 2 } },
    );
    const turn = steered();
    const take = turn.request.steering?.take;
    turn.request.steering = {
      take: async () => {
        const taken = (await take?.()) ?? [];
        turn.mailbox.push("Use Postgres");
        return taken;
      },
    };

    await agent.runTurn(turn.request);

    expect(types().at(-1)).toBe("turn.completed");
    // Left for whoever closes the request to queue as the next turn, which has a budget of its own.
    expect(turn.mailbox).toEqual(["Use Postgres"]);
  });

  it("does not fail a finished turn by steering it when the next request would not be paid for", async () => {
    const { agent } = run(
      [
        [
          { text: "Done.", usage: { inputTokens: 49_990, outputTokens: 1 } },
          { text: "Switched to Postgres." },
        ],
      ],
      { budget: { maxTokens: 50_000 } },
    );
    const turn = steered();
    turn.request.context = { ...turn.request.context, budgetTokens: 80_000 };
    const take = turn.request.steering?.take;
    turn.request.steering = {
      take: async () => {
        const taken = (await take?.()) ?? [];
        turn.mailbox.push("Use Postgres");
        return taken;
      },
    };

    await agent.runTurn(turn.request);

    expect(types().at(-1)).toBe("turn.completed");
    expect(turn.mailbox).toEqual(["Use Postgres"]);
  });

  it("counts the reply a steer would follow when deciding there is room to answer it", async () => {
    // The steer goes after the model's last reply, which the next request carries and the last
    // one did not. Ten thousand tokens in, a ceiling of thirteen thousand leaves room for a steer
    // alone but not for a three-thousand-token reply in front of it.
    const { agent } = run([
      [
        { text: "x".repeat(12_000), usage: { inputTokens: 10_000, outputTokens: 3_000 } },
        { text: "Switched to Postgres." },
      ],
    ]);
    const turn = steered();
    turn.request.context = { ...turn.request.context, budgetTokens: 13_000 };
    const take = turn.request.steering?.take;
    turn.request.steering = {
      take: async () => {
        const taken = (await take?.()) ?? [];
        // Sent while the model writes its reply, once.
        if (turn.takes() === 1) turn.mailbox.push("Use Postgres");
        return taken;
      },
    };

    await agent.runTurn(turn.request);

    expect(types().at(-1)).toBe("turn.completed");
    expect(turn.mailbox).toEqual(["Use Postgres"]);
  });

  it("takes nothing at the top of a step that is going to fail before calling the model", async () => {
    const { agent, provider } = run(
      [
        [
          {
            toolCalls: [call("read_file", { path: APP }, "a")],
            usage: { inputTokens: 49_990, outputTokens: 1 },
          },
          { text: "unused" },
        ],
      ],
      { budget: { maxTokens: 50_000 } },
    );
    const turn = steered();
    turn.request.context = { ...turn.request.context, budgetTokens: 80_000 };
    const read = manager.readFile.bind(manager);
    manager.readFile = async (id, path) => {
      if (path === APP) turn.mailbox.push("Use Postgres");
      return read(id, path);
    };

    await agent.runTurn(turn.request);

    expect(provider.requests).toHaveLength(1);
    expect(payloads("turn.failed")).toEqual([
      expect.objectContaining({ reason: "budget_exceeded" }),
    ]);
    // Not marked read by a turn that never called the model again.
    expect(turn.mailbox).toEqual(["Use Postgres"]);
  });

  it("asks a cancelled turn for nothing", async () => {
    const controller = new AbortController();
    controller.abort();
    const { agent } = run([[{ text: "unused" }]]);
    const turn = steered({ signal: controller.signal });

    await agent.runTurn(turn.request);

    expect(turn.takes()).toBe(0);
    expect(types().at(-1)).toBe("turn.failed");
  });

  it("asks a turn cancelled as its model finished for nothing more", async () => {
    // Stopped after the model's last reply arrived and before the loop decided what to do with
    // it — a Stop the row does not know about, such as a shutdown, lands exactly there. A steer
    // taken now would be marked read by a turn that is about to fail without answering it.
    const controller = new AbortController();
    const { agent } = run([[{ text: "Done." }, { text: "unused" }]]);
    const turn = steered({
      signal: controller.signal,
      onEvent: (event) => {
        events.push(event);
        if (event.type === "agent.message") controller.abort();
      },
    });
    const take = turn.request.steering?.take;
    turn.request.steering = {
      take: async () => {
        const taken = (await take?.()) ?? [];
        // Sent while the first step's model call runs, once.
        if (turn.takes() === 1) turn.mailbox.push("Use Postgres");
        return taken;
      },
    };

    await agent.runTurn(turn.request);

    expect(payloads("turn.failed")).toEqual([expect.objectContaining({ reason: "cancelled" })]);
    expect(turn.takes()).toBe(1);
    expect(turn.mailbox).toEqual(["Use Postgres"]);
  });

  it("lets a turn that ended on a question end, leaving the steer for the next turn", async () => {
    const { agent, provider } = run([
      [
        {
          toolCalls: [
            call(
              "ask_user",
              {
                question: "Which layout?",
                options: [
                  { label: "Grid", description: null },
                  { label: "List", description: null },
                ],
                multiSelect: false,
              },
              "q",
            ),
          ],
        },
      ],
    ]);
    const turn = steered();
    const before = turn.takes;

    await agent.runTurn(turn.request);
    turn.mailbox.push("too late for this turn");

    expect(provider.requests).toHaveLength(1);
    expect(before()).toBe(1);
    expect(turn.mailbox).toEqual(["too late for this turn"]);
  });

  it("offers no steers to a turn whose context cannot say how one reads", async () => {
    const { agent } = run([[{ text: "ok" }]]);
    const turn = steered();
    const { renderSteer: _unused, ...context } = turn.request.context;
    turn.mailbox.push("waiting");

    await agent.runTurn({ ...turn.request, context });

    expect(turn.takes()).toBe(0);
  });
});

describe("a follow-up turn's first change", () => {
  // A fresh turn knows nothing of the files yet: this is the turn after the one that read them.
  it("edits from what it remembers without a read round trip, and still cannot overwrite blind", async () => {
    const { agent, provider } = run([
      [
        {
          toolCalls: [
            call("edit_file", { path: APP, old_string: "app\n", new_string: "App\n" }, "edit"),
            call("write_file", { path: OTHER, contents: "clobbered\n" }, "write"),
          ],
        },
        { text: "Done." },
      ],
    ]);

    await agent.runTurn(request());

    expect(
      payloads("tool.call").map((payload) => (payload as { toolName: string }).toolName),
    ).toEqual(["edit_file", "write_file"]);
    expect(payloads("tool.result")).toEqual([
      expect.objectContaining({ toolCallId: "edit", ok: true }),
      expect.objectContaining({ toolCallId: "write", ok: false }),
    ]);
    expect(provider.requests).toHaveLength(2);
    expect(await manager.readFile(sandboxId, APP)).toEqual({ ok: true, value: "App\n" });
    expect(await manager.readFile(sandboxId, OTHER)).toEqual({ ok: true, value: "other\n" });
    expect(types().at(-1)).toBe("turn.completed");
  });
});

describe("what one turn read, the next", () => {
  /**
   * Even with the file unchanged. The next turn's context empties what the earlier one read, so
   * a ledger carried across turns — keyed by path, or by the file's bytes — would let the model
   * overwrite a file whose contents are no longer in front of it.
   */
  it("does not count as known, because the next turn's context no longer holds it", async () => {
    const NEXT = "8d0c2b63-9e4f-4a32-b1d5-2c3e4f5a6b7c";
    const { agent, provider } = run([
      [{ toolCalls: [call("read_file", { path: APP }, "read")] }, { text: "Read it." }],
      [
        { toolCalls: [call("write_file", { path: APP, contents: "rewritten\n" }, "write")] },
        { text: "Done." },
      ],
    ]);
    const asked = {
      type: "user.message",
      sessionId: SESSION_ID,
      turnId: TURN_ID,
      createdAt: "2026-11-13T12:00:00.000Z",
      payload: { text: "Look at App.tsx." },
    } as const;
    await agent.runTurn(request());
    const history: NapEvent[] = [asked, ...events].map((event, index) =>
      NapEventSchema.parse({ ...event, seq: index + 1 }),
    );
    events = [];

    const context = await new NapContextEngine().build({
      sessionId: SESSION_ID,
      sandboxId,
      userMessage: "Now rewrite it.",
      model: "openai/gpt-5.6-luna",
      history,
      sandbox: stubSandbox([APP]),
      memory: new NoopMemoryProvider(),
    });
    // The same service, the file untouched since it was read: only the turn is new.
    await agent.runTurn(request({ turnId: NEXT, context }));

    const earlierRead = (provider.requests[2]?.messages ?? [])
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .find((block) => block.type === "tool_result" && block.toolCallId === "read");
    expect(earlierRead).toMatchObject({ content: STALE_TOOL_OUTPUT });
    expect(payloads("tool.result")).toEqual([
      expect.objectContaining({ toolCallId: "write", ok: false }),
    ]);
    expect(await manager.readFile(sandboxId, APP)).toEqual({ ok: true, value: "app\n" });
  });
});
