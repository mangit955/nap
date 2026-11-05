/**
 * The tools that talk to the person rather than to the sandbox: a visible checklist, a question
 * that ends the turn, and a plan proposed for approval, which ends it too.
 *
 * Both validate against the same schemas the events carry (`@nap/shared/agent-plan`), so what
 * the model was allowed to send is exactly what the pane is allowed to render.
 */

import type { LLMToolCall } from "@nap/shared/ports/llm-provider";
import { emit, type ToolContext, type ToolOutcome } from "./context.ts";
import type { ToolArgs } from "./definitions.ts";

export async function todoWrite(
  args: ToolArgs<"todo_write">,
  call: LLMToolCall,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const working = args.todos.filter((item) => item.status === "in_progress").length;
  // One thing at a time is what makes the list worth watching: two items "in progress" is a
  // list that has stopped saying what is happening.
  if (working > 1)
    return {
      ok: false,
      output: `${working} items are in_progress. Mark exactly one in_progress — the one you are working on now.`,
    };
  emit(ctx, { type: "plan.updated", payload: { toolCallId: call.id, items: args.todos } });
  const done = args.todos.filter((item) => item.status === "completed").length;
  return {
    ok: true,
    output: `Plan updated: ${done} of ${args.todos.length} done. Keep it current as you work.`,
  };
}

export async function askUser(
  args: ToolArgs<"ask_user">,
  call: LLMToolCall,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const labels = new Set(args.options.map((option) => option.label.toLowerCase()));
  if (labels.size !== args.options.length)
    return { ok: false, output: "Two options have the same label. Make each answer distinct." };
  emit(ctx, {
    type: "agent.question",
    payload: {
      toolCallId: call.id,
      question: args.question,
      options: args.options,
      multiSelect: args.multiSelect,
    },
  });
  return {
    ok: true,
    endsTurn: true,
    output:
      "The question is in front of the person and your turn ends here. Their answer arrives as their next message.",
  };
}

/**
 * A plan mode turn's answer: the plan, in front of the person, and the turn over (ADR-0025).
 *
 * Refused outside plan mode even though the toolset already leaves it out there, because the
 * consequence of a stray call is not small: a turn that ended "awaiting approval" skips its
 * commit, and an ordinary turn that did work must never skip it.
 */
export async function proposePlan(
  args: ToolArgs<"propose_plan">,
  call: LLMToolCall,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  if (ctx.planning !== true)
    return {
      ok: false,
      output: "propose_plan is only for plan mode. This turn builds; carry on with the work.",
    };
  emit(ctx, {
    type: "plan.proposed",
    payload: { toolCallId: call.id, title: args.title, plan: args.plan },
  });
  return {
    ok: true,
    endsTurn: true,
    awaits: "plan_approval",
    output:
      "The plan is in front of the person and your turn ends here. If they approve it, the next turn carries it out; if they ask for changes, you will plan again.",
  };
}
