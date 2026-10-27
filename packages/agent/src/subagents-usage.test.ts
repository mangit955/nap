import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import type { AgentTurnRequest } from "@nap/shared/ports/agent-service";
import type { PendingEvent } from "@nap/shared/ports/event-store";
import { describe, expect, it } from "vitest";
import { NapAgentService } from "./agent-service.ts";
import { TurnBudget } from "./safety/budget.ts";
import { SubagentPool } from "./subagents.ts";
import { ScriptedLLMProvider, type ScriptedTurn } from "./testing/scripted-llm-provider.ts";
import { PROJECT_ROOT } from "./tools/definitions.ts";

function gate() {
  let release: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const KNOWN = { inputTokens: 300, outputTokens: 20 };
const LATE = { inputTokens: 1500, outputTokens: 100 };
const ZERO = { inputTokens: 0, outputTokens: 0 };
const PATH = `${PROJECT_ROOT}/routes.ts`;
const nextTask = () => new Promise<void>((resolve) => setImmediate(resolve));

async function fixture(script: ScriptedTurn, background = true, ready?: Promise<void>) {
  const sandbox = new InMemorySandboxManager();
  const created = await sandbox.create("helper-usage");
  if (!created.ok) throw new Error(created.error.message);
  const provider = new ScriptedLLMProvider([
    [
      {
        toolCalls: [
          {
            id: "launch",
            name: "run_subagent",
            input: { profile: "explore", task: "Find routes.", background },
          },
        ],
      },
      { text: "done" },
      { text: "done" },
      { text: "done" },
    ],
    script,
  ]);
  const start = provider.startTurn.bind(provider);
  let started = 0;
  provider.startTurn = (options) => {
    const turn = start(options);
    if (++started === 1 && ready !== undefined) {
      const complete = turn.complete.bind(turn);
      let calls = 0;
      turn.complete = async (request) => {
        if (++calls > 1) await ready;
        return complete(request);
      };
    }
    return turn;
  };
  const events: PendingEvent[] = [];
  const request: AgentTurnRequest = {
    sessionId: "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77",
    turnId: "7c9b1a52-8d3e-4f21-a0c4-1b2d3e4f5a6b",
    sandboxId: created.value.id,
    sandbox,
    context: {
      systemPrompt: "Coordinate a search.",
      messages: [{ role: "user", content: "Find routes." }],
      estimatedTokens: 10,
      subagentPrompts: { explore: "Search.", general: "Build." },
    },
    onEvent: (event) => events.push(event),
  };
  const run = () =>
    new NapAgentService({ provider, budget: { maxTokens: 50_000 } }).runTurn(request);
  return { sandbox, provider, events, request, run };
}

describe("helper usage completeness", () => {
  it.each([false, true])(
    "marks abandoned model usage incomplete and retains earlier known usage: %s",
    async (earlierUsage) => {
      const entered = gate();
      const held = gate();
      const returned = gate();
      const f = await fixture(
        [
          ...(earlierUsage
            ? [
                {
                  usage: KNOWN,
                  toolCalls: [{ id: "read", name: "read_file", input: { path: PATH } }],
                },
              ]
            : []),
          { text: "late report", usage: LATE },
        ],
        true,
        entered.promise,
      );
      const start = f.provider.startTurn.bind(f.provider);
      let started = 0;
      let observedUsage = () => ZERO;
      let helperSignal: AbortSignal | undefined;
      f.provider.startTurn = (options) => {
        const turn = start(options);
        if (++started === 2) {
          observedUsage = () => turn.usage();
          const complete = turn.complete.bind(turn);
          let calls = 0;
          turn.complete = async (request) => {
            if (++calls === (earlierUsage ? 2 : 1)) {
              helperSignal = request.signal;
              entered.release();
              await held.promise;
              try {
                return await complete(request);
              } finally {
                returned.release();
              }
            }
            return complete(request);
          };
        }
        return turn;
      };
      const running = f.run();
      let atTerminal: PendingEvent[] = [];
      try {
        await entered.promise;
        // Completion must not depend on releasing a transport that ignores abort.
        await running;
        atTerminal = structuredClone(f.events);
        const terminal = f.events.find((event) => event.type === "turn.completed");
        expect(terminal).toMatchObject({
          payload: {
            usage: earlierUsage ? KNOWN : ZERO,
            usageIncomplete: true,
          },
        });
        expect(f.events.find((event) => event.type === "subagent.completed")).toMatchObject({
          payload: { outcome: "cancelled", usage: earlierUsage ? KNOWN : ZERO },
        });
        expect(helperSignal?.aborted).toBe(true);
      } finally {
        held.release();
        await running;
        await returned.promise;
      }
      await nextTask();
      expect(observedUsage()).toEqual({
        inputTokens: LATE.inputTokens + (earlierUsage ? KNOWN.inputTokens : 0),
        outputTokens: LATE.outputTokens + (earlierUsage ? KNOWN.outputTokens : 0),
      });
      expect(f.events).toEqual(atTerminal);
      expect(f.events.at(-1)?.type).toBe("turn.completed");
    },
  );

  it("keeps usage complete when cancellation abandons a tool read after a known model result", async () => {
    const entered = gate();
    const held = gate();
    const returned = gate();
    const f = await fixture(
      [
        {
          usage: KNOWN,
          toolCalls: [{ id: "read", name: "read_file", input: { path: PATH } }],
        },
      ],
      true,
      entered.promise,
    );
    const read = f.sandbox.readFile.bind(f.sandbox);
    f.sandbox.readFile = async (id, path) => {
      if (path !== PATH) return read(id, path);
      entered.release();
      await held.promise;
      try {
        return await read(id, path);
      } finally {
        returned.release();
      }
    };
    const running = f.run();
    let atTerminal: PendingEvent[] = [];
    try {
      await entered.promise;
      await running;
      atTerminal = structuredClone(f.events);
      const terminal = f.events.find((event) => event.type === "turn.completed");
      expect(terminal).toMatchObject({ payload: { usage: KNOWN } });
      if (terminal?.type !== "turn.completed") throw new Error("Missing parent completion");
      expect(terminal.payload.usageIncomplete).toBeUndefined();
      expect(f.events.find((event) => event.type === "subagent.completed")).toMatchObject({
        payload: { outcome: "cancelled", usage: KNOWN },
      });
    } finally {
      held.release();
      await running;
      await returned.promise;
    }
    await nextTask();
    expect(f.events).toEqual(atTerminal);
  });

  it.each([
    { text: "report", usage: KNOWN },
    { refusal: true, usage: KNOWN },
    { error: { message: "unavailable", retryable: false }, usage: KNOWN },
  ])("accounts delivered responses without an incomplete marker: %j", async (response) => {
    const f = await fixture([response], false);
    await f.run();
    const terminal = f.events.find((event) => event.type === "turn.completed");
    expect(terminal).toMatchObject({ payload: { usage: KNOWN } });
    if (terminal?.type !== "turn.completed") throw new Error("Missing parent completion");
    expect(terminal.payload.usageIncomplete).toBeUndefined();
  });

  it.each(["throw", "reject"])(
    "marks a model request %s incomplete while preserving earlier delivered usage",
    async (failure) => {
      const f = await fixture(
        [
          {
            usage: KNOWN,
            toolCalls: [{ id: "read", name: "read_file", input: { path: PATH } }],
          },
        ],
        false,
      );
      const start = f.provider.startTurn.bind(f.provider);
      let started = 0;
      f.provider.startTurn = (options) => {
        const turn = start(options);
        if (++started === 2) {
          const complete = turn.complete.bind(turn);
          let calls = 0;
          turn.complete = (request) => {
            if (++calls === 2) {
              const error = new Error("Transport failed before delivering usage");
              if (failure === "throw") throw error;
              return Promise.reject(error);
            }
            return complete(request);
          };
        }
        return turn;
      };
      await f.run();
      expect(f.events.find((event) => event.type === "subagent.completed")).toMatchObject({
        payload: { outcome: "failed", usage: KNOWN },
      });
      expect(f.events.find((event) => event.type === "turn.completed")).toMatchObject({
        payload: { usage: KNOWN, usageIncomplete: true },
      });
    },
  );

  it("does not mark unknown usage when already aborted before model dispatch", async () => {
    const f = await fixture([]);
    const controller = new AbortController();
    controller.abort();
    const helpers = new SubagentPool({
      provider: f.provider,
      budget: new TurnBudget({ maxTokens: 50_000 }),
      modelFor: () => undefined,
      credentials: undefined,
      prompts: { explore: "Search.", general: "Build." },
      request: { ...f.request, signal: controller.signal },
      emit: f.request.onEvent,
      now: () => "2026-01-01T00:00:00.000Z",
    });
    expect(
      (await helpers.run({ toolCallId: "sub", profile: "explore", task: "Find routes." })).ok,
    ).toBe(false);
    await helpers.settle();
    expect(f.provider.requests).toHaveLength(0);
    expect(helpers.usage()).toEqual(ZERO);
    expect(helpers.usageIncomplete()).toBe(false);
  });
});
