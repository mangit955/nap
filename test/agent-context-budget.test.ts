/**
 * The fixed text the coding agent is sent, held to a committed size.
 *
 * The system prompts, the helper prompts and the tool declarations are fixed text at the head of
 * every request of their kind — every turn, every plan, every helper — so a sentence added to any
 * of them is paid for on each of those requests, and nothing else notices it arrive. Pinning
 * their size in `agent-context-budget.json` makes every change to that size show up in the diff
 * that caused it, where a reviewer can ask whether it was worth it. The check is equality, not a
 * ceiling: text that shrinks has to be recorded too, or the budget slowly stops describing what is
 * sent and the next addition hides in the slack.
 *
 * Only what the model reads is counted: UTF-8 bytes of each prompt, and of each tool set as the
 * JSON of `name`, `description` and `inputSchema` — the provider's own wrapping is protocol, not
 * context. What rides in a turn's own message — the file listing, the job brief, skills, an
 * approved plan, compaction history — is assembled per turn and is not budgeted here.
 *
 * It lives in `test/` because it reads both `@nap/context` and `@nap/agent`, which the dependency
 * rule forbids from reading each other.
 */

import { TOOL_DEFINITIONS } from "@nap/agent/tools/definitions";
import { type ToolsetOptions, toolsetFor } from "@nap/agent/tools/toolset";
import { EXPLORE_PROMPT, GENERAL_PROMPT } from "@nap/context/subagent-prompts";
import {
  PLAN_MODE_PROMPT,
  REPOSITORY_SYSTEM_PROMPT,
  SYSTEM_PROMPT,
} from "@nap/context/system-prompt";
import { describe, expect, it } from "vitest";
// Imported rather than read from disk so the pre-commit hook's `vitest --changed` runs this test
// when only the budget is edited.
import budget from "./agent-context-budget.json" with { type: "json" };

/**
 * The tool sets that are pinned, each one the declarations of a real request.
 *
 * All are on the deployment's default model, an OpenAI one with image input, so they carry
 * `apply_patch` and, with a desktop composed, `computer`. `projectTurn` is a person's turn on a
 * Nap project, which is offered no helpers; `repositoryTurn` is the same turn on an imported
 * repository, which is, and is the largest set any turn declares. `planTurn` is the only set that
 * holds `propose_plan`, and `appTest` is what an app test may reach. The helper sets are what each
 * helper sends on every request. Which tools a model family loses is `toolset.test.ts`'s to pin.
 */
const TOOL_SETS = {
  projectTurn: { promptSource: "user", family: "gpt", computer: true, subagents: false },
  repositoryTurn: { promptSource: "user", family: "gpt", computer: true, subagents: true },
  planTurn: { promptSource: "user", family: "gpt", computer: true, subagents: true, mode: "plan" },
  appTest: { promptSource: "test", family: "gpt", computer: true, subagents: false },
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
      exploreHelper: bytes(EXPLORE_PROMPT),
      generalHelper: bytes(GENERAL_PROMPT),
    },
    tools: Object.fromEntries(
      Object.entries(TOOL_SETS).map(([set, options]) => [set, toolBytes(options)]),
    ),
  };
}

describe("the agent's fixed context", () => {
  it("is the size the committed budget says", () => {
    expect(
      measure(),
      "The agent's fixed context changed size. Set test/agent-context-budget.json to the measured " +
        "values, so the change is visible in review. Before you cut text to fit, measure the cut " +
        "with NapBench (docs/NAPBENCH.md): its tasks run Nap-project turns and app tests, and none " +
        "runs an imported repository, plan mode or a helper, so a cut there is unmeasured — say so " +
        "in the PR. On fakes it scores nothing; a real run spends money and needs approval.",
    ).toEqual(budget);
  });

  it("budgets every tool in the registry", () => {
    // A tool that no pinned set declares could change size, or be added, with nothing noticing.
    const pinned = new Set(
      Object.values(TOOL_SETS).flatMap((options) => toolsetFor(options).map((tool) => tool.name)),
    );
    expect(
      [...pinned].sort(),
      "A tool is declared by no set in TOOL_SETS, so its size is unbudgeted. Add the set that " +
        "declares it to TOOL_SETS, and its measured size to test/agent-context-budget.json.",
    ).toEqual(TOOL_DEFINITIONS.map((tool) => tool.name).sort());
  });
});
