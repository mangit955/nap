/**
 * Which tools one turn is offered.
 *
 * Every tool exists in the registry; not every turn should be able to reach every tool. The
 * reasons are all facts about the turn rather than preferences, which is why this is one pure
 * function of them (ADR-0020):
 *
 *  - **Who asked.** An app test may look but not touch. A repair turn has nobody watching, so a
 *    question would wait forever for an answer.
 *  - **What is wired.** The computer needs a desktop and an image-capable model; delegation
 *    needs a runner.
 *  - **Which model family.** Models are trained on different editing tools. GPT models were
 *    trained on the patch format and are offered it; Claude models edit by exact replacement and
 *    are not handed a second way to do the same thing, which only costs prefix tokens.
 *  - **Whether this is a helper.** A subagent gets a narrower set than its parent, and never
 *    the tools that talk to the person or start further helpers.
 *
 * The order of the result follows the registry, not the order of the rules below, so the tool
 * block — the head of every cached prefix — is byte-identical between two turns offered the
 * same set.
 */

import type { SubagentProfile } from "@nap/shared/agent-plan";
import type { PromptSource, ToolName } from "@nap/shared/events";
import { APP_TEST_TOOL_NAMES, TOOL_DEFINITIONS, type ToolDefinition } from "./definitions.ts";

export type ModelFamily = "gpt" | "claude";

/**
 * Read from the model id, which is the only thing that says.
 *
 * OpenRouter namespaces by vendor (`openai/…`); a bare id, or one under `anthropic/`, is a
 * Claude model on every route this repo uses. An unknown vendor gets the Claude set, which is
 * the conservative one: exact replacement works for any model that can copy text.
 */
export function modelFamily(model: string | undefined): ModelFamily {
  return model?.startsWith("openai/") === true ? "gpt" : "claude";
}

export type ToolsetOptions = {
  promptSource: PromptSource;
  family: ModelFamily;
  computer: boolean;
  subagents: boolean;
  /** Set when choosing for a helper rather than for a turn. */
  subagent?: SubagentProfile | undefined;
};

const EXPLORE: readonly ToolName[] = ["read_file", "list_files", "glob", "search_files"];
const GENERAL: readonly ToolName[] = [
  ...EXPLORE,
  "write_file",
  "edit_file",
  "apply_patch",
  "run_command",
];

export function toolNamesFor(options: ToolsetOptions): Set<ToolName> {
  const offered = new Set<ToolName>(
    options.subagent === "explore"
      ? EXPLORE
      : options.subagent === "general"
        ? GENERAL
        : options.promptSource === "test"
          ? APP_TEST_TOOL_NAMES
          : TOOL_DEFINITIONS.map((tool) => tool.name),
  );
  if (!options.computer) offered.delete("computer");
  if (!options.subagents || options.subagent !== undefined) {
    offered.delete("run_subagent");
    offered.delete("read_subagent");
  }
  if (options.promptSource !== "user" || options.subagent !== undefined) offered.delete("ask_user");
  if (options.subagent !== undefined) offered.delete("todo_write");
  if (options.family !== "gpt") offered.delete("apply_patch");
  return offered;
}

export function toolsetFor(options: ToolsetOptions): ToolDefinition[] {
  const offered = toolNamesFor(options);
  return TOOL_DEFINITIONS.filter((tool) => offered.has(tool.name));
}
