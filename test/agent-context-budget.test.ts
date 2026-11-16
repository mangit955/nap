/**
 * The fixed text the coding agent is sent, held to a committed size.
 *
 * The system prompts, the helper prompts and the tool declarations are the head of every request
 * the agent makes, so a sentence added to any of them is paid for on every request of every turn,
 * and nothing else notices it arrive. Pinning their size in `agent-context-budget.json` makes
 * every change to that size show up in the diff that caused it, where a reviewer can ask whether
 * it was worth it. The check is equality, not a ceiling: text that shrinks has to be recorded too,
 * or the budget slowly stops describing what is sent and the next addition hides in the slack.
 *
 * Only what the model reads is counted: UTF-8 bytes of each prompt, and of each tool set as the
 * JSON of `name`, `description` and `inputSchema` — the provider's own wrapping is protocol, not
 * context. Text assembled per turn (the file listing, the job brief, skills, compaction history,
 * the plan itself inside the approved-plan frame) changes with the project and is not budgeted.
 *
 * It lives in `test/` because it reads both `@nap/context` and `@nap/agent`, which the dependency
 * rule forbids from reading each other.
 */

import { readFileSync } from "node:fs";
import { TOOL_DEFINITIONS } from "@nap/agent/tools/definitions";
import { type ToolsetOptions, toolsetFor } from "@nap/agent/tools/toolset";
import { EXPLORE_PROMPT, GENERAL_PROMPT } from "@nap/context/subagent-prompts";
import {
  PLAN_MODE_PROMPT,
  REPOSITORY_SYSTEM_PROMPT,
  renderApprovedPlan,
  SYSTEM_PROMPT,
} from "@nap/context/system-prompt";
import { describe, expect, it } from "vitest";

const BUDGET_FILE = new URL("./agent-context-budget.json", import.meta.url);

/**
 * The tool sets that are pinned, each one a real request's declarations.
 *
 * `turn` is a person's turn on the deployment's default model (an OpenAI one, so it carries
 * `apply_patch`) with a desktop and helpers wired: the largest set any turn declares, and the one
 * a production turn sends. `planTurn` is the only set that holds `propose_plan`, so between them
 * every tool's text is budgeted. The helper sets are what each helper sends on every request.
 */
const TOOL_SETS = {
  turn: { promptSource: "user", family: "gpt", computer: true, subagents: true },
  planTurn: { promptSource: "user", family: "gpt", computer: true, subagents: true, mode: "plan" },
  exploreHelper: {
    promptSource: "user",
    family: "gpt",
    computer: false,
    subagents: false,
    subagent: "explore",
  },
  generalHelper: {
    promptSource: "user",
    family: "gpt",
    computer: false,
    subagents: false,
    subagent: "general",
  },
} satisfies Record<string, ToolsetOptions>;

function bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** The tool list as the model reads it: what each declaration says, without the wrapping. */
function toolBytes(options: ToolsetOptions): number {
  const tools = toolsetFor(options).map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
  }));
  return bytes(JSON.stringify(tools));
}

function measure() {
  return {
    prompts: {
      system: bytes(SYSTEM_PROMPT),
      repositorySystem: bytes(REPOSITORY_SYSTEM_PROMPT),
      planMode: bytes(PLAN_MODE_PROMPT),
      // The frame around an approved plan is fixed text; the plan inside it is the person's.
      approvedPlanFrame: bytes(renderApprovedPlan({ title: "", plan: "" })),
      exploreHelper: bytes(EXPLORE_PROMPT),
      generalHelper: bytes(GENERAL_PROMPT),
    },
    tools: {
      turn: toolBytes(TOOL_SETS.turn),
      planTurn: toolBytes(TOOL_SETS.planTurn),
      exploreHelper: toolBytes(TOOL_SETS.exploreHelper),
      generalHelper: toolBytes(TOOL_SETS.generalHelper),
    },
  };
}

describe("the agent's fixed context", () => {
  it("is the size the committed budget says", () => {
    const budget: unknown = JSON.parse(readFileSync(BUDGET_FILE, "utf8"));
    expect(
      measure(),
      "The agent's fixed context changed size. Set test/agent-context-budget.json to the measured " +
        "values, so the change is visible in review. Before you cut text to fit, run the NapBench " +
        "tasks that cover it (docs/NAPBENCH.md) — on fakes it scores nothing, so a real run needs " +
        "approval.",
    ).toEqual(budget);
  });

  it("budgets every tool in the registry", () => {
    // A tool that no pinned set declares could change size, or be added, with nothing noticing.
    const pinned = new Set(
      Object.values(TOOL_SETS).flatMap((options) => toolsetFor(options).map((tool) => tool.name)),
    );
    expect([...pinned].sort()).toEqual(TOOL_DEFINITIONS.map((tool) => tool.name).sort());
  });
});
