/**
 * What the model is told it can do.
 *
 * The SDK's built-in file and shell tools act on this API server's filesystem, not on the
 * user's sandbox, so they stay disabled. File and command tools proxy to `SandboxManager`;
 * the computer uses `SandboxDesktop` and object storage behind ports.
 *
 * This file is the registry's declaration half (ADR-0020): every tool's name, argument schema
 * and description, in one place. Which of them a given turn is *offered* is `toolset.ts`'s
 * decision, and what each one does is its handler's — `execute.ts` maps one to the other.
 *
 * Argument shapes are Zod schemas, and the JSON Schema the model sees is derived from them
 * rather than written beside them. That is the only way the thing validating a tool call and
 * the thing describing it cannot drift apart.
 *
 * The descriptions say *when* to reach for a tool, not only what it does. On this model a
 * trigger condition in the description moves how often a tool is chosen more than anything in
 * the system prompt does, and the schemas plus the prompt are the cached prefix of every
 * request — so wording here is paid for once and read on every turn.
 */

import { PlanSchema, QuestionSchema, SubagentProfileSchema } from "@nap/shared/agent-plan";
import { ComputerActionSchema } from "@nap/shared/computer";
import { TOOL_NAMES, type ToolName } from "@nap/shared/events";
import type { LLMToolDefinition } from "@nap/shared/ports/llm-provider";
import { z } from "zod";

/**
 * Where the generated app lives inside the sandbox.
 *
 * Stated here rather than imported from the sandbox package, which is a sibling this one may
 * not depend on. It is the working directory the project template builds into, and the system
 * prompt tells the model the same thing; the three have to agree.
 */
export const PROJECT_ROOT = "/home/user/app";

/** How many lines one `read_file` returns when the model does not say. */
export const DEFAULT_READ_LINES = 2_000;

const path = z.string().min(1).describe(`Absolute path, for example ${PROJECT_ROOT}/src/App.tsx`);
const shellId = z
  .string()
  .regex(/^[a-z0-9]{1,32}$/)
  .describe("The id run_command returned when it started the command in the background");

export const TOOL_SCHEMAS = {
  computer: z.strictObject({ actions: z.array(ComputerActionSchema).min(1).max(32) }),
  read_file: z.strictObject({
    path,
    offset: z.int().min(1).optional().describe("First line to read, counting from 1"),
    limit: z
      .int()
      .min(1)
      .max(DEFAULT_READ_LINES)
      .optional()
      .describe(`How many lines to read. Defaults to ${DEFAULT_READ_LINES}`),
  }),
  write_file: z.strictObject({
    path,
    contents: z.string().describe("The complete new contents of the file"),
  }),
  edit_file: z.strictObject({
    path,
    old_string: z
      .string()
      .min(1)
      .describe(
        "Exact text to replace, including whitespace, without the line-number prefix read_file shows. Must appear exactly once unless replace_all is true.",
      ),
    new_string: z.string().describe("Text to put in its place. Empty to delete."),
    replace_all: z.boolean().optional().describe("Replace every occurrence instead of one"),
  }),
  apply_patch: z.strictObject({
    patch: z
      .string()
      .min(1)
      .describe("The whole patch, from *** Begin Patch to *** End Patch, in the format above"),
  }),
  list_files: z.strictObject({ path }),
  glob: z.strictObject({
    pattern: z.string().min(1).describe("Glob such as src/**/*.tsx, relative to path"),
    path: z
      .string()
      .min(1)
      .optional()
      .describe(`Directory to match under. Defaults to ${PROJECT_ROOT}`),
  }),
  search_files: z.strictObject({
    pattern: z.string().min(1).describe("Extended regular expression"),
    path: z.string().min(1).optional().describe(`Directory to search. Defaults to ${PROJECT_ROOT}`),
    glob: z.string().min(1).optional().describe("Only search files whose name matches, e.g. *.tsx"),
    ignore_case: z.boolean().optional(),
    files_only: z.boolean().optional().describe("List matching files instead of matching lines"),
  }),
  run_command: z.strictObject({
    command: z.string().min(1).describe(`Shell command, run in ${PROJECT_ROOT}`),
    background: z
      .boolean()
      .optional()
      .describe("Start it and return at once with a shell id, for servers and long jobs"),
    timeout_seconds: z
      .int()
      .min(1)
      .max(600)
      .optional()
      .describe("How long to wait for a foreground command. Defaults to 60"),
  }),
  shell_output: z.strictObject({
    shell_id: shellId,
    wait_seconds: z
      .int()
      .min(0)
      .max(60)
      .optional()
      .describe("Wait up to this long for the command to finish first. Defaults to 0"),
  }),
  shell_input: z.strictObject({
    shell_id: shellId,
    text: z.string().min(1).describe("Typed into the command's input. End with \\n to press Enter"),
  }),
  shell_kill: z.strictObject({ shell_id: shellId }),
  todo_write: z.strictObject({ todos: PlanSchema }),
  ask_user: QuestionSchema,
  run_subagent: z.strictObject({
    profile: SubagentProfileSchema.describe(
      "explore reads and searches only; general may also edit files and run commands",
    ),
    task: z
      .string()
      .min(1)
      .max(4_000)
      .describe("Everything it needs to know: it sees none of this conversation"),
    background: z
      .boolean()
      .optional()
      .describe("Return at once with an id and keep working; collect it with read_subagent"),
  }),
  read_subagent: z.strictObject({
    subagent_id: z.string().min(1).describe("The id run_subagent returned"),
  }),
} satisfies Record<ToolName, z.ZodType>;

export type ToolSchemas = typeof TOOL_SCHEMAS;
export type ToolArgs<K extends ToolName> = z.output<ToolSchemas[K]>;

const PATCH_FORMAT = `Format:
*** Begin Patch
*** Add File: <path>
+<every line of the new file, each prefixed with +>
*** Update File: <path>
*** Move to: <new path, optional>
@@ <optional line identifying the region, such as a function signature>
 <context line, prefixed with a space>
-<line to remove>
+<line to add>
*** Delete File: <path>
*** End Patch
Give about three lines of unchanged context around each change. Paths are absolute or relative to ${PROJECT_ROOT}.`;

const DESCRIPTIONS: Record<ToolName, string> = {
  computer:
    "Operate the project app on its 1024×768 desktop when you need to see or exercise its UI. Actions run in order and return one final screenshot. Use read_dom and console for observations. No JavaScript execution is available.",
  read_file:
    "Read a file from the project, with line numbers. You must read a file in this turn before editing or overwriting it. For a large file, read the part you need with offset and limit.",
  write_file:
    "Create a file, or replace one entirely. Use this for new files; prefer edit_file when changing part of an existing one, because this overwrites everything. An existing file must have been read first.",
  edit_file:
    "Replace an exact stretch of text in a file you have read this turn. old_string must match the file byte for byte and appear exactly once, so include enough surrounding lines to be unambiguous — or set replace_all to change every occurrence, such as when renaming.",
  apply_patch: `Edit, create, move or delete files with one patch. Prefer it when a change touches several places or several files.\n${PATCH_FORMAT}`,
  list_files:
    "List the direct contents of one directory. Call this when you need to know what exists before reading or creating files.",
  glob: "Find files by name pattern, such as **/*.test.tsx. Call this to locate files when you know roughly what they are called; it skips node_modules and .git.",
  search_files:
    "Search file contents across the project for a pattern. Call this to find where something is defined or used rather than reading files one by one.",
  run_command:
    "Run a shell command in the project directory for builds, tests and package management. A non-zero exit is reported back to you, not treated as a failure of the tool. Set background for anything that keeps running, such as a server or a watcher, and read it with shell_output.",
  shell_output:
    "Read what a background command has printed since you last looked, and whether it has exited. Set wait_seconds to wait for it to finish first.",
  shell_input:
    "Type into a background command that is waiting for input, such as a prompt asking a question.",
  shell_kill:
    "Stop a background command. Use it when a server or watcher you started is no longer needed.",
  todo_write:
    "Keep a short checklist of the work, visible to the person watching. Use it for work with three or more distinct steps: write the list first, mark one item in_progress while you work on it, and mark items completed as soon as they are done. Send the whole list each time. Skip it for small requests.",
  ask_user:
    "Ask the person a multiple-choice question, and end your turn to wait for the answer. Only when two readings of the request lead to materially different work and you cannot reasonably choose; otherwise decide and proceed.",
  run_subagent:
    "Hand a self-contained task to a helper with its own fresh context, and get back its final report. Use explore to search a large codebase for where something lives, so the search does not fill your own context; several explore helpers can run at once. Do not use it for a file or two you could read yourself.",
  read_subagent:
    "Wait for a helper started with background set, and get its final report. Every background helper must be read before you finish.",
};

/**
 * Tools that change nothing, so several may run at once.
 *
 * A function of the call rather than of the name, because one tool is both: an `explore` helper
 * only reads, while a `general` one may write, and two writers racing on one tree is exactly the
 * thing running calls in order exists to prevent.
 */
export function runsConcurrently(name: string, input: Record<string, unknown>): boolean {
  switch (name) {
    case "read_file":
    case "list_files":
    case "glob":
    case "search_files":
      return true;
    case "run_subagent":
      return input.profile === "explore" && input.background !== true;
    default:
      return false;
  }
}

/** Strips the dialect marker: it is noise on every request and buys the model nothing. */
function inputSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

export const APP_TEST_TOOL_NAMES: readonly ToolName[] = [
  "read_file",
  "list_files",
  "glob",
  "search_files",
  "computer",
];

/** A definition whose name is known to be a real tool, so nothing downstream has to assert it. */
export type ToolDefinition = LLMToolDefinition & { name: ToolName };

/** Every tool, in the closed list's order. A turn is offered a subset — see `toolset.ts`. */
export const TOOL_DEFINITIONS: ToolDefinition[] = TOOL_NAMES.map((name) => ({
  name,
  description: DESCRIPTIONS[name],
  inputSchema: inputSchema(TOOL_SCHEMAS[name]),
}));
