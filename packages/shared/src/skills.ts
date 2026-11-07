/**
 * Repository skills: instruction packs a project carries for one kind of work (ADR-0029).
 *
 * A skill is a folder holding a `SKILL.md` — YAML frontmatter naming it and saying in one line
 * when it applies, then the instructions — plus whatever files those instructions refer to. The
 * agent is shown only the names and descriptions, and loads a skill's instructions when the work
 * in front of it matches one.
 *
 * Everything here reads the workspace through `SandboxManager`, because the project's files live
 * in its sandbox and never on the host running this code. Discovery is three single-level
 * listings and one read per skill, all in parallel, under one deadline — never a walk, never a
 * command, so it works against every fake and costs one round of requests at the start of a turn.
 *
 * Nothing about a skill can fail a turn. A file that is malformed, oversized or a duplicate is
 * skipped with a reason somebody can act on, and a sandbox that cannot answer makes the skills
 * *unavailable* this turn rather than absent, the way the file listing is.
 */

import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { NapEventOf } from "./events.ts";
import { TOOL_NAMES, type ToolName } from "./events.ts";
import type { SandboxError, SandboxManager } from "./ports/sandbox-manager.ts";
import type { Result } from "./result.ts";

/**
 * Where skills are looked for, under the project root, in precedence order.
 *
 * Nap's own folder first, so a project can override a skill an imported repository brought with
 * it. The other two are the conventions repositories already use for other agents; honouring them
 * means an imported repository's skills work without being moved. Nothing deeper than one folder
 * per skill: a `SKILL.md` elsewhere in the tree is documentation, not a skill.
 */
export const SKILL_ROOTS = [".nap/skills", ".agents/skills", ".claude/skills"] as const;

export const SKILL_FILE = "SKILL.md";

/**
 * How many skills one project may offer. Every one costs its description on every turn, and a
 * repository with more than this many is better served by fewer, broader skills.
 */
export const MAX_SKILLS = 32;

/** A description is one line about *when* to load the skill, not the skill itself. */
export const MAX_SKILL_DESCRIPTION = 500;

/**
 * The largest `SKILL.md`, frontmatter included, in characters.
 *
 * Under the tool output ceiling with room for the framing the `skill` tool adds, so a loaded skill
 * is never cut short in the middle of its instructions. A longer skill should move its detail into
 * files beside it, which the agent reads only when the instructions send it there.
 */
export const MAX_SKILL_CHARS = 24_000;

/** How long discovery may hold up the start of a turn. The file listing's deadline. */
export const SKILL_DISCOVERY_TIMEOUT_MS = 5_000;

/**
 * Names the `skill` tool is called with: no spaces, no slashes, nothing a path could be built from.
 * Case is kept as written, because repositories already name their skills.
 */
export const SkillNameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "use letters, digits, dots, dashes and underscores");

/**
 * The frontmatter Nap reads. Unknown keys are dropped rather than refused: other harnesses write
 * `license`, `metadata` and their own settings into the same files, and refusing those would skip
 * most imported skills over keys that mean nothing here.
 */
const FrontmatterSchema = z.object({
  name: SkillNameSchema,
  description: z.string().trim().min(1, "is empty").max(MAX_SKILL_DESCRIPTION),
  "allowed-tools": z.union([z.string(), z.array(z.string())]).optional(),
});

/** A skill as discovery found it: enough to list it, and to find it again. */
export type SkillSummary = {
  name: string;
  description: string;
  /** The `SKILL.md`, absolute. */
  path: string;
  /** The folder it sits in, absolute — where any file it refers to is. */
  directory: string;
  /** What `allowed-tools` listed, as written; `null` when it said nothing. See `readAllowedTools`. */
  allowedTools: string[] | null;
};

export type ParsedSkill = SkillSummary & { body: string };

export type SkippedSkill = { path: string; reason: string };

export type SkillIndex = {
  skills: SkillSummary[];
  skipped: SkippedSkill[];
  /** Set when the sandbox could not be asked, so "no skills" is not something anyone may infer. */
  unavailable?: string;
};

/** One `SKILL.md` read into a skill, or the reason it is not one. Never throws. */
export function parseSkill(path: string, text: string): Result<ParsedSkill, string> {
  if (text.length > MAX_SKILL_CHARS)
    return fail(
      `SKILL.md is ${text.length} characters; the limit is ${MAX_SKILL_CHARS}. Move detail into files beside it`,
    );
  const normalized = text.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const match = /^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)([\s\S]*)$/.exec(normalized);
  if (match === null)
    return fail(
      "no frontmatter: SKILL.md must open with a --- block giving its name and description",
    );
  const [, head = "", rest = ""] = match;

  let fields: unknown;
  try {
    // No aliases: a skill has no use for them, and they are how a small YAML file becomes a large one.
    fields = parseYaml(head, { maxAliasCount: 0, uniqueKeys: true });
  } catch (error) {
    const message = error instanceof Error ? (error.message.split("\n")[0] ?? "") : String(error);
    return fail(`frontmatter is not valid YAML: ${message}`);
  }
  if (typeof fields !== "object" || fields === null || Array.isArray(fields))
    return fail("frontmatter must be a mapping with name and description");

  const parsed = FrontmatterSchema.safeParse(fields);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "frontmatter"} ${issue.message}`)
      .join("; ");
    return fail(`frontmatter: ${issues}`);
  }

  const body = rest.trim();
  if (body === "") return fail("has no instructions below its frontmatter");

  const allowed = parsed.data["allowed-tools"];
  return {
    ok: true,
    value: {
      name: parsed.data.name,
      // One line in the listing, however the YAML folded it.
      description: parsed.data.description.replace(/\s+/g, " "),
      path,
      directory: path.slice(0, path.lastIndexOf("/")),
      allowedTools: allowed === undefined ? null : entries(allowed),
      body,
    },
  };
}

function fail(reason: string): Result<never, string> {
  return { ok: false, error: reason };
}

/**
 * `allowed-tools` as a list. A string is split on commas, or on spaces when there are none, at the
 * top level only, so `Bash(git status:*)` stays one entry.
 */
function entries(value: string | string[]): string[] {
  if (Array.isArray(value)) return value.map((entry) => entry.trim()).filter((e) => e !== "");
  const separator = value.includes(",") ? /,/ : /\s/;
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of value) {
    if (char === "(") depth += 1;
    if (char === ")") depth = Math.max(depth - 1, 0);
    if (depth === 0 && separator.test(char)) {
      out.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  out.push(current);
  return out.map((entry) => entry.trim()).filter((entry) => entry !== "");
}

/**
 * Names other harnesses use in `allowed-tools`, mapped onto the Nap tools that do the same job.
 * Lower-cased, since repositories write them both ways.
 */
const ALIASES: Readonly<Record<string, readonly ToolName[]>> = {
  read: ["read_file"],
  write: ["write_file"],
  edit: ["edit_file", "apply_patch"],
  multiedit: ["edit_file", "apply_patch"],
  glob: ["glob"],
  grep: ["search_files"],
  ls: ["list_files"],
  bash: ["run_command", "shell_output", "shell_input", "shell_kill"],
  todowrite: ["todo_write"],
  task: ["run_subagent", "read_subagent"],
};

/**
 * What a skill's `allowed-tools` lets the rest of a turn use, in the registry's order.
 *
 * This only ever *narrows*: the caller intersects it with what the turn was already offered, and a
 * skill can never reach a tool the turn did not have. So the safe reading of anything unclear is
 * the smaller one. An unknown name grants nothing, and neither does a scoped entry such as
 * `Bash(git:*)`: Nap cannot hold a tool to some of its arguments, and granting the whole tool
 * would be wider than the author asked for. Both come back in `ignored`, so the agent and the log
 * can say what was not honoured.
 */
export function readAllowedTools(value: string | readonly string[]): {
  tools: ToolName[];
  ignored: string[];
} {
  const listed = typeof value === "string" ? entries(value) : [...value];
  const granted = new Set<ToolName>();
  const ignored: string[] = [];
  const own: ReadonlySet<string> = new Set(TOOL_NAMES);
  for (const entry of listed) {
    if (own.has(entry)) {
      granted.add(entry as ToolName);
      continue;
    }
    const alias = Object.hasOwn(ALIASES, entry.toLowerCase())
      ? ALIASES[entry.toLowerCase()]
      : undefined;
    if (alias === undefined) {
      ignored.push(entry);
      continue;
    }
    for (const tool of alias) granted.add(tool);
  }
  return { tools: TOOL_NAMES.filter((name) => granted.has(name)), ignored };
}

/**
 * Every skill in the project, or the reason they could not be listed. Never throws, and never
 * takes longer than `timeoutMs`.
 */
export async function discoverSkills(
  sandbox: SandboxManager,
  sandboxId: string,
  root: string,
  options: { timeoutMs?: number } = {},
): Promise<SkillIndex> {
  const timeoutMs = options.timeoutMs ?? SKILL_DISCOVERY_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<SkillIndex>((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          skills: [],
          skipped: [],
          unavailable: `the sandbox did not answer within ${timeoutMs}ms`,
        }),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([discover(sandbox, sandboxId, root), deadline]);
  } catch (error) {
    return {
      skills: [],
      skipped: [],
      unavailable: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function discover(
  sandbox: SandboxManager,
  sandboxId: string,
  root: string,
): Promise<SkillIndex> {
  const base = root.replace(/\/+$/, "");
  const listings = await Promise.all(
    SKILL_ROOTS.map((dir) => sandbox.listFiles(sandboxId, `${base}/${dir}`)),
  );

  const folders: string[] = [];
  for (const listing of listings) {
    if (!listing.ok) {
      // A missing folder is the usual case: most projects have none of the three.
      if (listing.error.code === "file_not_found") continue;
      return { skills: [], skipped: [], unavailable: describe(listing.error) };
    }
    folders.push(
      ...listing.value
        .filter((node) => node.type === "directory")
        .map((node) => node.path)
        .sort(),
    );
  }

  const skipped: SkippedSkill[] = folders.slice(MAX_SKILLS).map((folder) => ({
    path: `${folder}/${SKILL_FILE}`,
    reason: `more than ${MAX_SKILLS} skills in this project; this one was not read`,
  }));
  const reads = await Promise.all(
    folders.slice(0, MAX_SKILLS).map(async (folder) => {
      const path = `${folder}/${SKILL_FILE}`;
      return { path, read: await sandbox.readFile(sandboxId, path) };
    }),
  );

  const skills: SkillSummary[] = [];
  const named = new Map<string, string>();
  const unread: SkippedSkill[] = [];
  for (const { path, read } of reads) {
    if (!read.ok) {
      // A folder without one is a folder of shared files, not a broken skill.
      if (read.error.code !== "file_not_found")
        unread.push({ path, reason: `could not be read (${describe(read.error)})` });
      continue;
    }
    const parsed = parseSkill(path, read.value);
    if (!parsed.ok) {
      unread.push({ path, reason: parsed.error });
      continue;
    }
    const earlier = named.get(parsed.value.name);
    if (earlier !== undefined) {
      unread.push({
        path,
        reason: `another skill named ${parsed.value.name} is already defined at ${earlier}`,
      });
      continue;
    }
    named.set(parsed.value.name, path);
    const { body: _body, ...summary } = parsed.value;
    skills.push(summary);
  }
  return { skills, skipped: [...unread, ...skipped] };
}

function describe(error: SandboxError): string {
  return `${error.code}: ${error.message}`;
}

type SkillsDiscovered = NapEventOf<"skills.discovered">["payload"];

/** What the log records of an index: what a reader is shown, and nothing a re-read would change. */
export function skillsDiscoveredPayload(index: SkillIndex): SkillsDiscovered {
  return {
    skills: index.skills.map(({ name, description, path }) => ({ name, description, path })),
    skipped: index.skipped.map(({ path, reason }) => ({ path, reason })),
  };
}

/**
 * Whether `next` says nothing `previous` did not. A session with no record yet is unchanged by a
 * project with no skills, so a project that never has any never records anything.
 */
export function skillsUnchanged(
  previous: SkillsDiscovered | undefined,
  next: SkillsDiscovered,
): boolean {
  const empty = { skills: [], skipped: [] };
  return JSON.stringify(previous ?? empty) === JSON.stringify(next);
}
