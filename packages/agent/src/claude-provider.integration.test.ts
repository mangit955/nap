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

import type { LLMRequest, LLMTurnResult } from "@nap/shared/ports/llm-provider";
import { expect, it } from "vitest";
import { createBedrockClient, toBedrockModel } from "./bedrock.ts";
import {
  ClaudeProvider,
  type ClaudeProviderOptions,
  DEFAULT_MODEL_CONFIG,
} from "./claude-provider.ts";
import { createOpenRouterClient, toOpenRouterModel } from "./openrouter.ts";

/**
 * Whichever account is configured — the request shape is what is under test, not the biller.
 *
 * OpenRouter first, because it is the route this project uses; the other two are kept working
 * rather than kept current. Order matters more than it looks: Bedrock used to win, and AWS
 * credentials linger in `.env` from an experiment that is still blocked on model access, so
 * checking it first sent this test down a route that 403s for reasons having nothing to do
 * with the request shape.
 *
 * Nothing configured throws rather than skipping: a suite that quietly passes with nothing
 * behind it reports the contract as verified when nothing verified it.
 *
 * One limit worth naming — OpenRouter is a *translating* proxy, so a pass here proves that
 * OpenRouter accepted the request, not that Anthropic would. It could drop an unknown
 * parameter instead of rejecting it. Only a direct key closes that gap.
 */
function providerOptions(): ClaudeProviderOptions {
  if (process.env.OPENROUTER_API_KEY) {
    return { client: createOpenRouterClient(), model: toOpenRouterModel(MODEL) };
  }

  if (process.env.ANTHROPIC_API_KEY) return {};

  if (process.env.AWS_BEARER_TOKEN_BEDROCK) {
    if (!process.env.AWS_REGION) {
      throw new Error("AWS_BEARER_TOKEN_BEDROCK is set but AWS_REGION is not; Bedrock needs both.");
    }
    return { client: createBedrockClient(), model: toBedrockModel(MODEL) };
  }

  throw new Error(
    "No model credentials are set, so this run cannot verify anything. Put OPENROUTER_API_KEY " +
      "(or ANTHROPIC_API_KEY, or AWS_BEARER_TOKEN_BEDROCK + AWS_REGION) in apps/api/.env, " +
      "then re-run `bun run test:integration`.",
  );
}

/** The default this project ships. Named here so the Bedrock id is derived from it, not typed twice. */
const MODEL = DEFAULT_MODEL_CONFIG.model;

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

/** The reason an unhappy result carries, if it carries one. */
function describe(result: LLMTurnResult): string {
  return result.type === "error" ? result.message : "(no message)";
}

it("completes a real streamed call, returning a tool call and real usage", async () => {
  const turn = new ClaudeProvider(providerOptions()).startTurn();
  const request: LLMRequest = {
    systemPrompt:
      "You are editing a React project. When you need a file's contents, call read_file. " +
      "Do not guess at file contents.",
    messages: [{ role: "user", content: "What does src/App.tsx currently render?" }],
    tools: [READ_FILE],
  };

  const result = await turn.complete(request);

  if (result.type !== "message") {
    // The message, not just the type: "got error" names the branch and hides the reason,
    // which is the only part that tells you whether the model id, the region, the
    // credential or the request shape is what the API objected to.
    throw new Error(`expected a message, got ${result.type}: ${describe(result)}`);
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
  const turn = new ClaudeProvider(providerOptions()).startTurn();

  const first = await turn.complete({
    systemPrompt: "You are editing a React project. Call read_file when you need a file.",
    messages: [{ role: "user", content: "What does src/App.tsx render?" }],
    tools: [READ_FILE],
  });
  if (first.type !== "message" || first.toolCalls[0] === undefined) {
    throw new Error(`expected a tool call, got ${first.type}: ${describe(first)}`);
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
