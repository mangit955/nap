/**
 * A compaction summary, sent for real to every line's version that insists on reasoning.
 *
 * Summaries used to be asked for with thinking off. The newest Sol, Opus, Sonnet and Muse Ember
 * versions answer that with `400 Reasoning is mandatory`, so the first long turn on any of them
 * failed at its first summary. The stub tests pin the request body; only a real call proves the
 * route accepts it. The lines and versions come from the committed catalog snapshot, so this
 * follows the lines when the snapshot is refreshed.
 *
 * Asserts on structure only — a message came back — never on the summary's wording.
 */

import { SNAPSHOT_CATALOG } from "@nap/shared/model-catalog-snapshot";
import { resolveLines } from "@nap/shared/model-lines";
import type { LLMRequest } from "@nap/shared/ports/llm-provider";
import { describe, expect, it } from "vitest";
import { ClaudeProvider } from "./claude-provider.ts";
import { createOpenRouterClient } from "./openrouter.ts";

const catalog = SNAPSHOT_CATALOG;
const resolved = resolveLines(catalog, { now: new Date(), minContextTokens: 144_000 });
const mandatory = Object.values(resolved).flatMap((line) => {
  const listed = catalog.find((model) => model.id === line.model);
  return listed?.reasoning?.mandatory === true ? [listed.id] : [];
});

const SUMMARY: LLMRequest = {
  purpose: "compaction",
  // What `summaryRequest` asks for: the summary's room plus 8,192 for the reasoning.
  maxOutputTokens: 256 + 8_192,
  systemPrompt: "Summarise the conversation in one sentence.",
  messages: [{ role: "user", content: "The user asked for a todo app, and the agent built it." }],
  tools: [],
};

describe("a compaction summary on a version that requires reasoning", () => {
  it("has such versions to try", () => {
    // An empty list would make the cases below vanish and the suite pass on nothing.
    expect(mandatory.length).toBeGreaterThan(0);
  });

  it.each(mandatory)("is accepted by %s", async (model) => {
    if (!process.env.OPENROUTER_API_KEY)
      throw new Error("OPENROUTER_API_KEY is not set; put it in apps/api/.env.");
    const turn = new ClaudeProvider({ client: createOpenRouterClient(), model }).startTurn();
    const result = await turn.complete(SUMMARY);
    expect(result.type === "error" ? result.message : result.type).toBe("message");
  });
});
