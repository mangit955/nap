/**
 * Running one tool call against a sandbox.
 *
 * Everything the agent does to a project passes through here, so two properties matter more
 * than anything else in this file.
 *
 * **A tool never throws.** Every failure — a missing file, an edit that matched nothing, a
 * sandbox that is gone, arguments that do not parse — comes back as a result the model can read
 * and act on. A thrown exception would end the turn over something the model could have fixed
 * on the next step.
 *
 * **Events come out in a fixed order:** `tool.call`, then whatever the tool produced while
 * running, then `tool.result`. The result closes the pair, so anything replaying a session
 * sees an open call for exactly as long as the call was open. Sequence numbers are not
 * assigned here — the event store owns those, and an emitter that invented its own would
 * break replay ordering.
 *
 * The result is returned as well as emitted because the model has to be told what happened:
 * the caller feeds the same text back as a tool result block on the next request.
 */

import { type ToolName, ToolNameSchema } from "@nap/shared/events";
import type { LLMToolCall } from "@nap/shared/ports/llm-provider";
import type { z } from "zod";
import { runComputer } from "./computer.ts";
import { emit, type ToolContext, type ToolHandler, type ToolOutcome } from "./context.ts";
import { askUser, todoWrite } from "./conversation.ts";
import { TOOL_SCHEMAS, type ToolArgs } from "./definitions.ts";
import { readSubagent, runSubagent } from "./delegate.ts";
import { editFile, listFiles, readFile, writeFile } from "./files.ts";
import { applyPatch } from "./patch.ts";
import { globFiles, searchFiles } from "./search.ts";
import { runCommand, shellInput, shellKill, shellOutput } from "./shell.ts";

export type { ToolContext, ToolOutcome } from "./context.ts";

/**
 * How much text one tool may put into a turn.
 *
 * A build log has no natural size, and this string is stored in a jsonb column and then
 * replayed into the model's context on every subsequent request of the turn. Cutting it here
 * is cheaper than discovering the limit at either of those two places.
 */
export const MAX_TOOL_OUTPUT = 30_000;

/**
 * Every tool's implementation, keyed by name.
 *
 * A mapped type over the registry, so each handler is checked against its own tool's parsed
 * arguments, a tool added to the registry without a handler fails typecheck here, and the
 * dispatch below needs no cast to correlate a name with the shape of its arguments.
 */
const HANDLERS: { [K in ToolName]: ToolHandler<ToolArgs<K>> } = {
  computer: (args, call, ctx) => runComputer(args.actions, call.id, ctx),
  read_file: (args, _call, ctx) => readFile(args, ctx),
  write_file: (args, _call, ctx) => writeFile(args, ctx),
  edit_file: (args, _call, ctx) => editFile(args, ctx),
  apply_patch: (args, _call, ctx) => applyPatch(args, ctx),
  list_files: (args, _call, ctx) => listFiles(args, ctx),
  glob: (args, _call, ctx) => globFiles(args, ctx),
  search_files: (args, _call, ctx) => searchFiles(args, ctx),
  run_command: runCommand,
  shell_output: (args, _call, ctx) => shellOutput(args, ctx),
  shell_input: (args, _call, ctx) => shellInput(args, ctx),
  shell_kill: (args, _call, ctx) => shellKill(args, ctx),
  todo_write: todoWrite,
  ask_user: askUser,
  run_subagent: runSubagent,
  read_subagent: (args, _call, ctx) => readSubagent(args, ctx),
};

/** The registry's schemas, seen through the same mapping the handlers are. */
const PARSERS: { [K in ToolName]: z.ZodType<ToolArgs<K>> } = TOOL_SCHEMAS;

/** Runs one tool call, emitting its events and reporting what to tell the model. */
export async function executeTool(call: LLMToolCall, ctx: ToolContext): Promise<ToolOutcome> {
  const name = ToolNameSchema.safeParse(call.name);
  if (!name.success) {
    // There is no honest `tool.call` to write: the event log accepts only the declared real
    // names, and inventing one would put a tool in the history that does not exist.
    const available = ctx.offered === undefined ? ToolNameSchema.options : [...ctx.offered];
    return {
      ok: false,
      output: `No tool named ${call.name}. Available tools: ${available.join(", ")}.`,
    };
  }

  // A real tool this turn was not offered is a different thing: the attempt is worth having in
  // the log — an app test that tried to write a file is evidence about that test — so it is
  // recorded as a call and refused as its result, and nothing runs.
  const refusal =
    ctx.offered === undefined || ctx.offered.has(name.data)
      ? undefined
      : ctx.testMode
        ? "App tests can read source and use the computer. Source changes and commands require a separate repair turn."
        : `${name.data} is not available in this turn. Available tools: ${[...ctx.offered].join(", ")}.`;

  emit(ctx, {
    type: "tool.call",
    payload: { toolCallId: call.id, toolName: name.data, input: call.input },
  });

  const outcome: ToolOutcome =
    refusal === undefined ? await dispatch(name.data, call, ctx) : { ok: false, output: refusal };
  const capped = { ...outcome, output: truncate(outcome.output) };

  emit(ctx, {
    type: "tool.result",
    payload: {
      toolCallId: call.id,
      toolName: name.data,
      ok: capped.ok,
      output: capped.output,
    },
  });

  return capped;
}

/**
 * Validates one tool's arguments and hands them to its implementation.
 *
 * Generic over the name, so the parsed arguments and the handler are both indexed by the same
 * `K` and agree without a cast — the cast is exactly the thing that would go unnoticed when a
 * schema changes.
 */
async function dispatch<K extends ToolName>(
  name: K,
  call: LLMToolCall,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const args = PARSERS[name].safeParse(call.input);
  if (!args.success) return invalid(name, args.error);
  return HANDLERS[name](args.data, call, ctx);
}

/** Reports bad arguments by field path — "invalid" alone tells the model nothing to fix. */
function invalid(name: ToolName, error: z.ZodError): ToolOutcome {
  const issues = error.issues
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  return { ok: false, output: `Invalid arguments for ${name} — ${issues}` };
}

function truncate(output: string): string {
  if (output.length <= MAX_TOOL_OUTPUT) return output;
  const omitted = output.length - MAX_TOOL_OUTPUT;
  // Keeping the head rather than the tail: the first error in a build log is the one that
  // caused the rest.
  return `${output.slice(0, MAX_TOOL_OUTPUT)}\n… truncated, ${omitted} characters omitted`;
}
