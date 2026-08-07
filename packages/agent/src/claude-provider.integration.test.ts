/**
 * One real streamed call, against the real model.
 *
 * Everything else about this provider is verified against a stub, which proves the
 * mapping is self-consistent but cannot prove the request is one the API accepts. Model
 * id, effort level, thinking configuration and tool schema are all things the stub will
 * happily agree with and the server will reject with a 400 — so exactly one test here
 * sends the real thing.
 *
 * It asserts on structure only: a tool call arrived, tokens were spent. Never on prose —
 * `docs/PLAN.md` §3 — because the model's wording is not a contract and asserting on it
 * buys a flaky test in exchange for nothing.
 */

import type { LLMRequest } from "@nap/shared/ports/llm-provider";
import { expect, it } from "vitest";
import { ClaudeProvider } from "./claude-provider.ts";

if (process.env.ANTHROPIC_API_KEY === undefined || process.env.ANTHROPIC_API_KEY === "") {
  // Thrown, not skipped: a suite that quietly passes with nothing behind it reports the
  // contract as verified when nothing verified it.
  throw new Error(
    "ANTHROPIC_API_KEY is not set, so the Claude provider run cannot verify anything. " +
      "Put it in apps/api/.env or export it, then re-run `bun run test:integration`.",
  );
}

/**
 * A tool with one obvious use, so the turn ends in a tool call rather than a paragraph.
 * Deliberately trivial — this test is about the round trip, not about tool design.
 */
const READ_FILE = {
  name: "read_file",
  description: "Read a file from the project. Use this whenever you need a file's contents.",
  inputSchema: {
    type: "object",
    properties: { path: { type: "string", description: "Path relative to the project root" } },
    required: ["path"],
    additionalProperties: false,
  },
};

it("completes a real streamed call, returning a tool call and real usage", async () => {
  const turn = new ClaudeProvider().startTurn();
  const request: LLMRequest = {
    systemPrompt:
      "You are editing a React project. When you need a file's contents, call read_file. " +
      "Do not guess at file contents.",
    messages: [{ role: "user", content: "What does src/App.tsx currently render?" }],
    tools: [READ_FILE],
  };

  const result = await turn.complete(request);

  if (result.type !== "message") {
    throw new Error(`expected a message, got ${result.type}`);
  }
  expect(result.toolCalls).toHaveLength(1);
  expect(result.toolCalls[0]?.name).toBe("read_file");
  expect(result.toolCalls[0]?.input).toMatchObject({ path: expect.any(String) });

  // Usage is real and reached the turn's accumulator, not just the individual result.
  expect(result.usage.inputTokens).toBeGreaterThan(0);
  expect(result.usage.outputTokens).toBeGreaterThan(0);
  expect(turn.usage()).toEqual(result.usage);
});

it("feeds a tool result back and gets a second call on the same turn", async () => {
  // The whole reason the port carries content blocks: proving a tool result is a shape
  // the API accepts is something only a real call can do.
  const turn = new ClaudeProvider().startTurn();

  const first = await turn.complete({
    systemPrompt: "You are editing a React project. Call read_file when you need a file.",
    messages: [{ role: "user", content: "What does src/App.tsx render?" }],
    tools: [READ_FILE],
  });
  if (first.type !== "message" || first.toolCalls[0] === undefined) {
    throw new Error(`expected a tool call, got ${first.type}`);
  }
  const call = first.toolCalls[0];

  const second = await turn.complete({
    systemPrompt: "You are editing a React project. Call read_file when you need a file.",
    messages: [
      { role: "user", content: "What does src/App.tsx render?" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: call.id, name: call.name, input: call.input }],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            toolCallId: call.id,
            content: "export default function App() {\n  return <h1>Hello</h1>;\n}\n",
            isError: false,
          },
        ],
      },
    ],
    tools: [READ_FILE],
  });

  expect(second.type).toBe("message");
  // Both calls landed in one accumulator, which is what "per-turn usage" has to mean.
  expect(turn.usage().inputTokens).toBeGreaterThan(first.usage.inputTokens);
});
