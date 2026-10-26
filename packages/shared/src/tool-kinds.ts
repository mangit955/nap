/**
 * What each tool is *for*, as the people reading a session group them.
 *
 * The tool list grows (ADR-0020) and nothing reading the log should have to learn every new
 * name to say "read 3 files and ran 2 commands". A kind is the stable question; a name is the
 * detail. A `Record` over the closed name list, so a tool added without a kind fails typecheck
 * here rather than being summarised as nothing in the pane or the benchmark.
 */

import type { ToolName } from "./events.ts";

export type ToolKind =
  | "read"
  | "edit"
  | "search"
  | "execute"
  | "plan"
  | "ask"
  | "delegate"
  | "computer";

export const TOOL_KINDS: Record<ToolName, ToolKind> = {
  read_file: "read",
  write_file: "edit",
  edit_file: "edit",
  apply_patch: "edit",
  list_files: "search",
  glob: "search",
  search_files: "search",
  run_command: "execute",
  shell_output: "execute",
  shell_input: "execute",
  shell_kill: "execute",
  todo_write: "plan",
  ask_user: "ask",
  run_subagent: "delegate",
  read_subagent: "delegate",
  computer: "computer",
};
