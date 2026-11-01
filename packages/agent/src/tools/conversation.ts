/**
 * The tools that talk to the person rather than to the sandbox: a visible checklist, and a
 * question that ends the turn.
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
