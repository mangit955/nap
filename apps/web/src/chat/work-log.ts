/**
 * The work log's vocabulary: what the agent's tool calls are called on screen.
 *
 * A turn is twenty tool calls and three sentences, and the transcript shows the twenty as rows
 * of a work log rather than as a wall of mono lines. This module is everything that log *says* —
 * the sentence a finished group collapses into ("Read 3 files and ran 2 commands"), the label the
 * one call still going wears ("Running bun"), what one row is called, and how long a turn took.
 *
 * Adapted from T3 Code's work-log presentation (`summarizeToolGroup`, `liveWorkEntryLabel`,
 * `liveThoughtLine`, `formatDuration`), MIT — see `apps/web/THIRD_PARTY_NOTICES.md`. T3 has
 * dozens of tool kinds from several providers; Nap has six tools and they map onto four of T3's
 * actions, which is why the classification here is a table rather than a classifier.
 *
 * Pure, and beside `transcript.ts` for the reason that one is: the wording is the product, and
 * every case is checkable without rendering anything.
 */

import { TOOL_KINDS, type ToolKind } from "@nap/shared/tool-kinds";
import { computerActions } from "../computer/action-labels.ts";
import type { TranscriptItem } from "./transcript.ts";
import { shorten } from "./working-state.ts";

type Step = Extract<TranscriptItem, { kind: "step" }>;

/**
 * One row of the work log: a tool call, a passage of reasoning, or a file change that arrived
 * with no call open to hang it on (a client that connected between a call and its result).
 */
export type WorkEntry =
  | Step
  | Extract<TranscriptItem, { kind: "thinking" }>
  | Extract<TranscriptItem, { kind: "files" }>;

export type ToolGroupAction =
  | "read"
  | "edit"
  | "command"
  | "code-search"
  | "computer"
  | "plan"
  | "ask"
  | "delegate";

/** What a group is, for its icon: one kind of work, a thought, or several kinds. */
export type ToolGroupSummaryKind = ToolGroupAction | "reasoning" | "mixed";

/**
 * Each kind of tool on T3's actions. Keyed by kind rather than by name (`@nap/shared/tool-kinds`),
 * so a new tool is summarised by what it is for without this file learning its name. Listing and
 * globbing are searches for T3 too (`ls` is classified with `grep` and `glob`), and they read that
 * way: the agent was looking for something.
 */
const ACTIONS: Record<ToolKind, ToolGroupAction> = {
  read: "read",
  edit: "edit",
  search: "code-search",
  execute: "command",
  computer: "computer",
  plan: "plan",
  ask: "ask",
  delegate: "delegate",
};

export function toolGroupAction(entry: Step | Extract<WorkEntry, { kind: "files" }>) {
  return entry.kind === "files" ? "edit" : ACTIONS[TOOL_KINDS[entry.toolName]];
}

/**
 * The code `run_command` reported, which is the first line of what it told the model.
 *
 * A non-zero exit is deliberately a *successful* tool call (`packages/agent/src/tools/execute.ts`):
 * a failing build is something the model has to read and act on. So the status alone cannot say
 * the build failed, and this is the only other place the fact lives.
 */
export function commandExitCode(entry: WorkEntry): number | undefined {
  if (entry.kind !== "step" || entry.toolName !== "run_command") return undefined;
  const match = /^exit code (-?\d+)/.exec(entry.output);
  return match?.[1] === undefined ? undefined : Number.parseInt(match[1], 10);
}

/** A refused call, or a command that exited non-zero — both failed, to the person watching. */
export function entryFailed(entry: WorkEntry): boolean {
  if (entry.kind !== "step") return false;
  if (entry.status === "failed") return true;
  const code = commandExitCode(entry);
  return code !== undefined && code !== 0;
}

function toolEntries(entries: readonly WorkEntry[]) {
  return entries.filter(
    (entry): entry is Step | Extract<WorkEntry, { kind: "files" }> => entry.kind !== "thinking",
  );
}

function changedPaths(entry: Step | Extract<WorkEntry, { kind: "files" }>): readonly string[] {
  return entry.files.map((file) => file.path);
}

/** Edits count the files they changed, so three edits to one file read as one file changed. */
function actionCount(
  action: ToolGroupAction,
  entries: readonly (Step | Extract<WorkEntry, { kind: "files" }>)[],
) {
  if (action === "computer")
    return entries.reduce(
      (sum, entry) => sum + (entry.kind === "step" ? computerActions(entry.input).length : 0),
      0,
    );
  if (action !== "edit") return entries.length;
  const changed = new Set<string>();
  let withoutFiles = 0;
  for (const entry of entries) {
    const paths = changedPaths(entry);
    if (paths.length === 0) withoutFiles += 1;
    for (const path of paths) changed.add(path);
  }
  return changed.size + withoutFiles;
}

function actionLabel(action: ToolGroupAction, count: number): string {
  switch (action) {
    case "computer":
      return `Used computer - ${count} ${count === 1 ? "action" : "actions"}`;
    case "read":
      return `Read ${count} ${count === 1 ? "file" : "files"}`;
    case "edit":
      return `Changed ${count} ${count === 1 ? "file" : "files"}`;
    case "command":
      return `Ran ${count} ${count === 1 ? "command" : "commands"}`;
    case "code-search":
      return `Searched code ${count} ${count === 1 ? "time" : "times"}`;
    case "plan":
      return `Updated the plan${count === 1 ? "" : ` ${count} times`}`;
    case "ask":
      return `Asked ${count === 1 ? "a question" : `${count} questions`}`;
    case "delegate":
      return `Delegated ${count} ${count === 1 ? "task" : "tasks"}`;
  }
}

/**
 * Which kinds of work get named when a group did more than two. Changing the project and running
 * things in it are what somebody skimming wants to know happened; reading and searching are how
 * the agent got there.
 */
function actionPriority(action: ToolGroupAction): number {
  return action === "command" || action === "edit" ? 0 : 1;
}

/**
 * A finished group as one sentence: "Read 3 files, ran 2 commands, and performed 1 other action".
 *
 * At most two kinds are named, chosen by priority and then by which came first, and listed in the
 * order they happened; everything else is counted. Reasoning is not work and is left out, unless
 * reasoning is all the group holds.
 */
export function summarizeToolGroup(entries: readonly WorkEntry[]): {
  summary: string;
  hasFailure: boolean;
} {
  const tools = toolEntries(entries);
  if (entries.length > 0 && tools.length === 0) {
    return {
      summary: entries.length === 1 ? "Thought" : `Thought (×${entries.length})`,
      hasFailure: false,
    };
  }

  const groups = new Map<ToolGroupAction, (Step | Extract<WorkEntry, { kind: "files" }>)[]>();
  for (const entry of tools) {
    const action = toolGroupAction(entry);
    const group = groups.get(action);
    if (group === undefined) groups.set(action, [entry]);
    else group.push(entry);
  }

  const summaries = [...groups].map(([action, members], index) => ({
    index,
    count: members.length,
    priority: actionPriority(action),
    label: actionLabel(action, actionCount(action, members)),
  }));
  const selected = [...summaries]
    .sort((a, b) => a.priority - b.priority || a.index - b.index)
    .slice(0, 2)
    .sort((a, b) => a.index - b.index);
  const labels = selected.map(({ label }) => label);
  const remaining = tools.length - selected.reduce((count, group) => count + group.count, 0);
  if (remaining > 0) {
    labels.push(`Performed ${remaining} other ${remaining === 1 ? "action" : "actions"}`);
  }

  const words = labels.map((label, index) =>
    index === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1),
  );
  const summary =
    words.length < 3
      ? words.join(" and ")
      : `${words.slice(0, -1).join(", ")}, and ${words.at(-1)}`;

  return { summary, hasFailure: tools.some(entryFailed) };
}

export function toolGroupSummaryKind(entries: readonly WorkEntry[]): ToolGroupSummaryKind {
  const tools = toolEntries(entries);
  if (entries.length > 0 && tools.length === 0) return "reasoning";
  const actions = new Set(tools.map(toolGroupAction));
  const [only] = actions;
  return actions.size === 1 && only !== undefined ? only : "mixed";
}

/** What a tool's arguments say it was pointed at, with the sandbox's project root taken off. */
/** The file a change touched, and how many more — or nothing, before any change arrived. */
function changedLabel(step: Step): string | undefined {
  const [first] = step.files;
  if (first === undefined) return undefined;
  return step.files.length === 1
    ? shorten(first.path)
    : `${shorten(first.path)} +${step.files.length - 1} more`;
}

function argument(
  step: Step,
  key: "command" | "path" | "pattern" | "question" | "task",
): string | undefined {
  const value = (step.input as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() !== "" ? shorten(value.trim()) : undefined;
}

/** Markdown flattened to the words, for a label that has room for one line of them. */
function plainText(markdown: string): string {
  return markdown
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^[ \t]*(?:#{1,6}|[-*+]|\d+\.)[ \t]+/gm, "")
    .replace(/`+|\*\*|~~/g, "")
    .replace(/(^|[^\w*])[*_]([^*_\n]+)[*_](?![\w*])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * What one row says: a command is shown as itself, a read as what it read, a change as the file
 * it changed, a search as what it looked for. The verb lives in the icon beside it.
 */
export function workEntryDisplayLabel(entry: WorkEntry): string {
  if (entry.kind === "thinking") return plainText(entry.text) || "Thought";
  if (entry.kind === "files") {
    const [first] = entry.files;
    if (first === undefined) return "Changed files";
    return entry.files.length === 1
      ? shorten(first.path)
      : `${shorten(first.path)} +${entry.files.length - 1} more`;
  }

  switch (entry.toolName) {
    case "computer": {
      const count = computerActions(entry.input).length;
      return `Used computer - ${count} ${count === 1 ? "action" : "actions"}`;
    }
    case "run_command":
      return argument(entry, "command") ?? "Ran command";
    case "read_file": {
      const path = argument(entry, "path");
      return path === undefined ? "Read file" : `Read ${path}`;
    }
    case "write_file":
    case "edit_file":
      return changedLabel(entry) ?? argument(entry, "path") ?? "Changed files";
    case "search_files": {
      const pattern = argument(entry, "pattern");
      const path = argument(entry, "path");
      if (pattern !== undefined && path !== undefined) return `Searched ${pattern} in ${path}`;
      if (pattern !== undefined) return `Searched ${pattern}`;
      return path === undefined ? "Searched files" : `Searched in ${path}`;
    }
    case "list_files": {
      const path = argument(entry, "path");
      return path === undefined ? "Listed files" : `Listed ${path}`;
    }
    case "glob": {
      const pattern = argument(entry, "pattern");
      return pattern === undefined ? "Found files" : `Found ${pattern}`;
    }
    case "apply_patch":
      return changedLabel(entry) ?? "Patched files";
    case "shell_output":
      return "Read command output";
    case "shell_input":
      return "Typed into a command";
    case "shell_kill":
      return "Stopped a command";
    case "todo_write":
      return "Updated the plan";
    case "ask_user":
      return argument(entry, "question") ?? "Asked a question";
    case "run_subagent":
      return argument(entry, "task") ?? "Delegated a task";
    case "read_subagent":
      return "Collected a helper's report";
  }
}

/**
 * The live row's label: "Running bun" while it runs, "Ran bun" once it has, "Failed bun" if it
 * did. The program and nothing else — the full command is a click away, and a label that changes
 * every few seconds has to be readable at a glance.
 *
 * `active` is whether the turn is still live. A call this client never saw answered is not
 * "Running" once the turn has ended; it is history, and the past tense is the honest reading.
 */
export function liveWorkEntryLabel(entry: WorkEntry, active: boolean): string {
  if (entry.kind === "step" && entry.toolName === "run_command") {
    const command = argument(entry, "command");
    if (command !== undefined) {
      const verb = entryFailed(entry)
        ? "Failed"
        : entry.status === "running" && active
          ? "Running"
          : "Ran";
      return `${verb} ${commandProgramName(command) ?? "command"}`;
    }
  }
  return workEntryDisplayLabel(entry);
}

/** Shell builtins that set something up rather than doing the work the label should name. */
const SETUP = new Set(["cd", "export", "source", ".", "set", "unset", "alias", "true", ":"]);
/** Programs that launch another, whose name is the one worth showing. */
const WRAPPERS = new Set(["sudo", "env", "timeout", "nohup", "time", "exec", "command", "nice"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

/**
 * The program a shell command runs: `bun` for `cd app && CI=1 bun run build`.
 *
 * A small reading of the first useful word rather than T3's full shell parser — the agent writes
 * ordinary one-line commands, and the cases that matter are a leading `cd`, environment
 * assignments, a launcher like `sudo`, and a `bash -lc '…'` wrapper. Null when nothing in the
 * command is a program worth naming.
 */
export function commandProgramName(command: string, depth = 0): string | null {
  if (depth > 3) return null;
  const lines = command.split("\n").filter((line) => !/^\s*(#|$)/.test(line));
  const segments = lines.join("\n").split(/&&|\|\||;|\n/);

  for (const segment of segments) {
    const tokens = segment.trim().match(/'[^']*'|"[^"]*"|\S+/g) ?? [];
    let index = 0;
    while (index < tokens.length && ASSIGNMENT.test(tokens[index] ?? "")) index += 1;
    const first = tokens[index];
    if (first === undefined) continue;

    const program = first.split("/").at(-1) ?? first;
    if (SETUP.has(program)) continue;

    if (WRAPPERS.has(program)) {
      // Skip the launcher's own options and their values (`-u root`, `10s`) to the program.
      let next = index + 1;
      while (next < tokens.length) {
        const token = tokens[next] ?? "";
        if (token.startsWith("-")) {
          next += /^-[a-zA-Z]$/.test(token) && program === "sudo" ? 2 : 1;
        } else if (ASSIGNMENT.test(token) || (program === "timeout" && /^\d/.test(token))) {
          next += 1;
        } else break;
      }
      const rest = tokens.slice(next).join(" ");
      if (rest !== "") return commandProgramName(rest, depth + 1);
      continue;
    }

    if (SHELLS.has(program)) {
      const flag = tokens.findIndex((token, at) => at > index && /^-[a-z]*c$/.test(token));
      const script = flag === -1 ? undefined : tokens[flag + 1];
      if (script !== undefined)
        return commandProgramName(script.replace(/^['"]|['"]$/g, ""), depth + 1);
    }

    return program;
  }

  return null;
}

/**
 * One line of a thought, for the preview above the live row: its bold heading if it opens with
 * one, otherwise its first sentence — or the sentence still being written, whole.
 */
export function liveThoughtLine(markdown: string): string {
  const heading = /^\s*\*\*([^*\r\n]+)\*\*[ \t]*\r?(?:\n|$)/.exec(markdown)?.[1];
  const text = plainText(heading ?? markdown);
  if (heading !== undefined) return text;
  const end = /[.?!]["'”’)]?(?=\s)/.exec(text);
  return end ? text.slice(0, end.index + end[0].length) : text;
}

/**
 * The newest thing a passage of reasoning says.
 *
 * T3 previews the latest *thought*, and its providers hand it one thought per section. Nap joins
 * a run of streamed reasoning into one passage (`transcript.ts`), so the newest section is found
 * here: the last bold heading if the model writes them, otherwise the last paragraph. Previewing
 * the passage's start instead would pin the preview to the first thing the model thought while it
 * went on thinking underneath — and the preview staying live is the reason it exists.
 */
export function latestThought(text: string): string {
  const headings = [...text.matchAll(/^[ \t]*\*\*[^*\r\n]+\*\*[ \t]*$/gm)];
  const lastHeading = headings.at(-1);
  if (lastHeading?.index !== undefined) return liveThoughtLine(text.slice(lastHeading.index));
  const paragraphs = text.split(/\n\s*\n/).filter((paragraph) => paragraph.trim() !== "");
  const last = paragraphs.at(-1);
  return last === undefined ? "" : liveThoughtLine(last);
}

/** "250ms", "4.3s", "12s", "1m 12s": coarser as it grows, rounded before the unit is chosen. */
export function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs < 0) return "0ms";
  if (durationMs < 1_000) return `${Math.max(1, Math.round(durationMs))}ms`;
  if (durationMs < 10_000) {
    const tenths = Math.round(durationMs / 100) / 10;
    return tenths >= 10 ? "10s" : `${tenths.toFixed(1)}s`;
  }
  const totalSeconds = Math.round(durationMs / 1_000);
  // After rounding, so 59.6 seconds reads "1m" rather than "60s".
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0) parts.push(`${seconds}s`);
  return parts.join(" ");
}
