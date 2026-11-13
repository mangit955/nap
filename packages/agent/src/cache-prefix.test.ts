/**
 * The guard on prompt caching across turns: what one turn's first request cached, the next
 * turn's first request must repeat byte for byte and read at a breakpoint.
 *
 * Both halves are real — the context engine that assembles a turn and the mapper that renders
 * it for the API — because the regression this exists for lives in the seam between them. A
 * file the agent wrote, a repair's job brief or a rewritten old turn, placed anywhere before a
 * breakpoint, makes every turn's first call re-write the whole prefix at the cache-write price
 * and wait for it, and nothing else in the suite notices: every answer is still correct.
 *
 * What counts as the prefix is what the cache keys on: tools, then system, then messages, with
 * the markers themselves removed — a marker says where to cache, it is not part of what is.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { NapContextEngine } from "@nap/context/context-engine";
import { NoopMemoryProvider } from "@nap/context/noop-memory-provider";
import { stubSandbox } from "@nap/context/testing/stub-sandbox";
import { FakeSandboxDesktop } from "@nap/sandbox/testing/fake-sandbox-desktop";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { COMPUTER_IMAGES_HIGH_WATER, COMPUTER_IMAGES_KEPT } from "@nap/shared/computer-context";
import type { NapEvent, PromptSource } from "@nap/shared/events";
import type { BuiltContext, JobContext } from "@nap/shared/ports/context-engine";
import type { LLMMessage } from "@nap/shared/ports/llm-provider";
import { InMemoryObjectStore } from "@nap/storage/testing/in-memory-object-store";
import { describe, expect, it } from "vitest";
import { NapAgentService } from "./agent-service.ts";
import { toRequestParams } from "./claude-provider.ts";
import { ScriptedLLMProvider } from "./testing/scripted-llm-provider.ts";
import { toolsetFor } from "./tools/toolset.ts";

const SESSION = "6f1c1d3e-2b7a-4c5e-8f9a-0d1e2f3a4b5c";
const ROOT = "/home/user/app";

let seq = 0;
function event<T extends NapEvent["type"]>(
  type: T,
  turn: number,
  payload: Extract<NapEvent, { type: T }>["payload"],
): NapEvent {
  seq += 1;
  return {
    type,
    sessionId: SESSION,
    turnId: `1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c${String(turn).padStart(2, "0")}`,
    seq,
    createdAt: "2026-11-03T12:00:00.000Z",
    payload,
  } as NapEvent;
}

/** One finished turn: asked, read a file, wrote one, answered. The writes are the bulk. */
function turn(n: number, asked: string, wrote: string): NapEvent[] {
  return [
    event("user.message", n, { text: asked }),
    event("tool.call", n, {
      toolCallId: `read-${n}`,
      toolName: "read_file",
      input: { path: `${ROOT}/src/App.tsx` },
    }),
    event("tool.result", n, {
      toolCallId: `read-${n}`,
      toolName: "read_file",
      ok: true,
      output: "export function App() {\n  return null;\n}\n".repeat(40),
    }),
    event("tool.call", n, {
      toolCallId: `write-${n}`,
      toolName: "write_file",
      input: { path: `${ROOT}/${wrote}`, content: `export const x${n} = ${n};\n`.repeat(80) },
    }),
    event("tool.result", n, {
      toolCallId: `write-${n}`,
      toolName: "write_file",
      ok: true,
      output: `wrote ${wrote}`,
    }),
    event("agent.message", n, { text: `Done with turn ${n}.` }),
    // Its end, without which it is still running and nothing in it is stale yet.
    event("turn.completed", n, {
      usage: { inputTokens: 1, outputTokens: 1 },
      durationMs: 1,
      commitSha: null,
    }),
  ];
}

const BASE_FILES = [`${ROOT}/package.json`, `${ROOT}/index.html`, `${ROOT}/src/App.tsx`];
const turn1 = turn(1, "Build a todo list.", "src/Todo.tsx");
const turn2 = turn(2, "Add a dark mode toggle.", "src/Theme.tsx");
const REPAIR = "The project's checks failed after your last change. Fix what they report.";
const turn3 = turn(3, REPAIR, "src/Theme.test.tsx");

const DARK_MODE: JobContext = { objective: "Add a dark mode toggle.", attempts: [] };
const REPAIRING: JobContext = {
  objective: "Add a dark mode toggle.",
  attempts: [{ check: "typecheck", detail: "exit 2", output: "error TS2322: not assignable" }],
};

async function firstRequest(options: {
  history: NapEvent[];
  files: string[];
  userMessage: string;
  job?: JobContext;
  /** Who asked: a repair turn is the project's checks asking, and is offered less. */
  promptSource?: PromptSource;
}): Promise<Anthropic.MessageStreamParams> {
  const context: BuiltContext = await new NapContextEngine().build({
    sessionId: SESSION,
    sandboxId: "sbx_1",
    userMessage: options.userMessage,
    model: "openai/gpt-5.6-luna",
    history: options.history.map((stored) => ({ ...stored })),
    ...(options.job === undefined ? {} : { job: options.job }),
    sandbox: stubSandbox(options.files),
    memory: new NoopMemoryProvider(),
  });
  const tools = toolsetFor({
    promptSource: options.promptSource ?? "user",
    family: "gpt",
    computer: false,
    subagents: false,
  });
  return toRequestParams({ systemPrompt: context.systemPrompt, messages: context.messages, tools });
}

/** A body without its markers: the bytes a cache entry is keyed on. */
function unmarked<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (key, inner) => (key === "cache_control" ? undefined : inner)),
  );
}

function marked(block: unknown): boolean {
  return typeof block === "object" && block !== null && "cache_control" in block;
}

/**
 * The request rendered up to each block that carries a breakpoint, in order: every prefix this
 * request writes to the cache, or reads from it.
 */
function cachedPrefixes(body: Anthropic.MessageStreamParams): string[] {
  const tools = unmarked(body.tools);
  const system = Array.isArray(body.system) ? body.system : [];
  const prefixes: string[] = [];
  system.forEach((block, index) => {
    if (marked(block))
      prefixes.push(JSON.stringify(unmarked({ tools, system: system.slice(0, index + 1) })));
  });
  body.messages.forEach((message, index) => {
    const content = Array.isArray(message.content) ? message.content : [];
    content.forEach((block, at) => {
      if (!marked(block)) return;
      const messages = [
        ...body.messages.slice(0, index),
        { role: message.role, content: content.slice(0, at + 1) },
      ];
      prefixes.push(JSON.stringify(unmarked({ tools, system, messages })));
    });
  });
  return prefixes;
}

/**
 * What one turn left in the cache that the next can use: the instructions, and the conversation
 * up to its last breakpoint before the turn's own message. That message, and what rides in it,
 * is the turn's alone.
 */
function settled(body: Anthropic.MessageStreamParams): string[] {
  const prefixes = cachedPrefixes(body);
  return [...new Set([prefixes[0] ?? "", prefixes.at(-2) ?? ""])];
}

describe("the prefix a turn caches, the next turn reads", () => {
  const second = () =>
    firstRequest({
      history: turn1,
      files: [...BASE_FILES, `${ROOT}/src/Todo.tsx`],
      userMessage: "Add a dark mode toggle.",
      job: DARK_MODE,
    });
  // Turn 2 added a file, and this turn repairs its job: both used to be in the system prompt.
  const third = () =>
    firstRequest({
      history: [...turn1, ...turn2],
      files: [...BASE_FILES, `${ROOT}/src/Todo.tsx`, `${ROOT}/src/Theme.tsx`],
      userMessage: REPAIR,
      job: REPAIRING,
      promptSource: "verification",
    });
  const fourth = () =>
    firstRequest({
      history: [...turn1, ...turn2, ...turn3],
      files: [
        ...BASE_FILES,
        `${ROOT}/src/Todo.tsx`,
        `${ROOT}/src/Theme.tsx`,
        `${ROOT}/src/Theme.test.tsx`,
      ],
      userMessage: "Make the toggle round.",
    });

  it("survives a turn that added a file and a repair turn's job brief", async () => {
    const [b2, b3, b4] = [await second(), await third(), await fourth()];

    for (const [before, after] of [
      [b2, b3],
      [b3, b4],
    ] as const) {
      const reads = cachedPrefixes(after);
      for (const prefix of settled(before)) expect(reads).toContain(prefix);
    }
  });

  it("caches the conversation, not only the instructions", async () => {
    // Without this, a request with one breakpoint on the system prompt passes the test above
    // while every turn re-writes its whole history.
    const [b3, b4] = [await third(), await fourth()];

    const history = settled(b3).at(-1) ?? "";
    expect(history).toContain("Add a dark mode toggle.");
    expect(cachedPrefixes(b4)).toContain(history);
  });

  it("stays inside the four breakpoints the API allows", async () => {
    for (const body of [await second(), await third(), await fourth()]) {
      expect(cachedPrefixes(body).length).toBeLessThanOrEqual(4);
    }
  });
});

/**
 * The same guard inside one turn. Every request's conversation must open the next request's
 * byte for byte, or the whole rest of it is written to the cache again at the write price. Old
 * screenshots have to go — an image is about a thousand tokens — but each one turned into text
 * partway up the conversation is exactly such a rewrite, so they go in batches.
 */
describe("the prefix a computer step caches, the next step reads", () => {
  it("is rewritten only at a batch cut, with the images and the pairs intact", async () => {
    const steps = 12;
    const sandbox = new InMemorySandboxManager();
    const created = await sandbox.create("project");
    if (!created.ok) throw new Error(created.error.message);
    const provider = new ScriptedLLMProvider([
      [
        ...Array.from({ length: steps }, (_, i) => ({
          toolCalls: [
            { id: `screen-${i}`, name: "computer", input: { actions: [{ action: "screenshot" }] } },
          ],
        })),
        { text: "Looked." },
      ],
    ]);
    await new NapAgentService({ provider, retryDelayMs: 0 }).runTurn({
      sessionId: SESSION,
      turnId: "7c9b1a52-8d3e-4f21-a0c4-1b2d3e4f5a6b",
      sandboxId: created.value.id,
      sandbox,
      model: "openai/gpt-5.6-luna",
      context: {
        systemPrompt: "Check the page.",
        messages: [{ role: "user", content: "Look at the page a few times." }],
        estimatedTokens: 10,
      },
      onEvent: () => {},
      computer: {
        desktop: new FakeSandboxDesktop({
          bytes: new Uint8Array([255, 216, 255, 217]),
          width: 1024,
          height: 768,
        }),
        objects: new InMemoryObjectStore(),
        projectId: "project",
        devServerUrl: "http://localhost:5173",
        beforeStore: async () => {},
      },
    });

    const rendered = provider.requests.map((request) =>
      unmarked(toRequestParams(request).messages),
    );
    expect(rendered).toHaveLength(steps + 1);
    const rewritten: number[] = [];
    rendered.forEach((messages, index) => {
      const previous = rendered[index - 1];
      if (
        previous !== undefined &&
        JSON.stringify(messages.slice(0, previous.length)) !== JSON.stringify(previous)
      )
        rewritten.push(index);
    });
    // Request n carries n frames until one too many, then the newest few; then it refills.
    const gap = COMPUTER_IMAGES_HIGH_WATER - COMPUTER_IMAGES_KEPT + 1;
    const cuts: number[] = [];
    for (let at = COMPUTER_IMAGES_HIGH_WATER + 1; at <= steps; at += gap) cuts.push(at);
    expect(rewritten).toEqual(cuts);

    for (const request of provider.requests) {
      expect(framesIn(request.messages)).toBeLessThanOrEqual(COMPUTER_IMAGES_HIGH_WATER);
      const blocks = request.messages.flatMap((message) =>
        Array.isArray(message.content) ? message.content : [],
      );
      expect(
        blocks.flatMap((block) => (block.type === "tool_result" ? [block.toolCallId] : [])),
      ).toEqual(blocks.flatMap((block) => (block.type === "tool_use" ? [block.id] : [])));
    }
    // The frames were really sent: the request before the first cut carried the full batch.
    expect(framesIn(provider.requests[COMPUTER_IMAGES_HIGH_WATER]?.messages ?? [])).toBe(
      COMPUTER_IMAGES_HIGH_WATER,
    );
  });
});

function framesIn(messages: readonly LLMMessage[]): number {
  return messages
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .flatMap((block) =>
      block.type === "tool_result" && Array.isArray(block.content) ? block.content : [],
    )
    .filter((child) => child.type === "image").length;
}
