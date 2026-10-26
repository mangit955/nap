/**
 * Handing work to a helper, and collecting what it found.
 *
 * Thin by design: the helper is another model loop, which only the agent service can run, so
 * these handlers only check the request and pass it to `ctx.subagents`.
 */

import type { LLMToolCall } from "@nap/shared/ports/llm-provider";
import type { ToolContext, ToolOutcome } from "./context.ts";
import type { ToolArgs } from "./definitions.ts";

const UNAVAILABLE: ToolOutcome = { ok: false, output: "Helpers are not available in this turn." };

export async function runSubagent(
  args: ToolArgs<"run_subagent">,
  call: LLMToolCall,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  if (ctx.subagents === undefined) return UNAVAILABLE;
  // A helper that writes runs while the agent waits, like any other write: in the background it
  // would be editing the tree at the same moment as the agent that started it.
  if (args.background === true && args.profile !== "explore")
    return {
      ok: false,
      output:
        "Only an explore helper can run in the background. Run a general helper without background.",
    };
  const request = { toolCallId: call.id, profile: args.profile, task: args.task };
  if (args.background !== true) return ctx.subagents.run(request);
  const subagentId = ctx.subagents.start(request);
  return {
    ok: true,
    output: `Started helper ${subagentId}. Carry on, and collect its report with read_subagent before you finish.`,
  };
}

export async function readSubagent(
  args: ToolArgs<"read_subagent">,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  if (ctx.subagents === undefined) return UNAVAILABLE;
  return ctx.subagents.collect(args.subagent_id);
}
