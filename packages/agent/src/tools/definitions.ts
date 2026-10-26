/**
 * What the model is told it can do.
 *
 * The SDK's built-in file and shell tools act on this API server's filesystem, not on the
 * user's sandbox, so they stay disabled. File and command tools proxy to `SandboxManager`;
 * the computer uses `SandboxDesktop` and object storage behind ports.
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

const path = z.string().min(1).describe(`Absolute path, for example ${PROJECT_ROOT}/src/App.tsx`);

export const TOOL_SCHEMAS = {
  computer: z.strictObject({ actions: z.array(ComputerActionSchema).min(1).max(32) }),
  read_file: z.strictObject({ path }),
  write_file: z.strictObject({
    path,
    contents: z.string().describe("The complete new contents of the file"),
  }),
  edit_file: z.strictObject({
    path,
    old_string: z
      .string()
      .min(1)
      .describe("Exact text to replace, including whitespace. Must appear exactly once."),
    new_string: z.string().describe("Text to put in its place. Empty to delete."),
  }),
  list_files: z.strictObject({ path }),
  search_files: z.strictObject({
    pattern: z.string().min(1).describe("Basic regular expression, as grep accepts it"),
    path: z.string().min(1).optional().describe(`Directory to search. Defaults to ${PROJECT_ROOT}`),
  }),
  run_command: z.strictObject({
    command: z.string().min(1).describe(`Shell command, run in ${PROJECT_ROOT}`),
  }),
} satisfies Record<ToolName, z.ZodType>;

const DESCRIPTIONS: Record<ToolName, string> = {
  computer:
    "Operate the project app on its 1024×768 desktop when you need to see or exercise its UI. Actions run in order and return one final screenshot. Use read_dom and console for observations. No JavaScript execution is available.",
  read_file:
    "Read a file from the project. Call this before editing anything you have not already read this turn — the file may differ from what you expect.",
  write_file:
    "Create a file, or replace one entirely. Use this for new files; prefer edit_file when changing part of an existing one, because this overwrites everything.",
  edit_file:
    "Replace one exact stretch of text in a file. old_string must match the file byte for byte and appear exactly once, so include enough surrounding lines to be unambiguous.",
  list_files:
    "List the direct contents of one directory. Call this when you need to know what exists before reading or creating files.",
  search_files:
    "Search file contents across the project for a pattern. Call this to find where something is defined or used rather than reading files one by one.",
  run_command:
    "Run a shell command in the project directory. Use it for builds, tests, and package management. A non-zero exit is reported back to you, not treated as a failure of the tool.",
};

/** Strips the dialect marker: it is noise on every request and buys the model nothing. */
function inputSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _dialect, ...rest } = z.toJSONSchema(schema) as Record<string, unknown>;
  return rest;
}

export const APP_TEST_TOOL_NAMES: readonly ToolName[] = [
  "read_file",
  "list_files",
  "search_files",
  "computer",
];

export const TOOL_DEFINITIONS: LLMToolDefinition[] = TOOL_NAMES.map((name) => ({
  name,
  description: DESCRIPTIONS[name],
  inputSchema: inputSchema(TOOL_SCHEMAS[name]),
}));
