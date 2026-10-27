/**
 * A project's rules for a directory, shown to the model the first time it works there.
 *
 * Repositories write down how a part of the tree is meant to be changed — in `AGENTS.md`, or
 * `CLAUDE.md` before that name existed — and put the file beside the code it governs. A model
 * that edits `packages/db/schema.ts` without having opened `packages/db/AGENTS.md` breaks a rule
 * it was never shown. Reading every such file up front would spend the context on directories
 * the turn never touches, so the rules arrive with the first tool result that touches each
 * directory, appended to it.
 *
 * The project root is left to the caller. A Nap project's root guidance is the design brief the
 * system prompt already carries, and sending it twice buys nothing; an imported repository's
 * root guidance is the most important file in it.
 *
 * What a directory said is remembered for the turn, and forgotten when the conversation is
 * compacted — the result that carried it may be gone, and the rules still apply.
 */

import { posix } from "node:path";
import type { LLMToolCall } from "@nap/shared/ports/llm-provider";
import type { SandboxManager } from "@nap/shared/ports/sandbox-manager";
import type { ToolOutcome } from "../tools/context.ts";
import { PROJECT_ROOT } from "../tools/definitions.ts";
import { parsePatch } from "../tools/patch.ts";
import type { TurnHook } from "./hook.ts";

export const RULE_FILES = ["AGENTS.md", "CLAUDE.md"] as const;

/** Per file. A rules file longer than this is a document, and the head is where the rules are. */
export const MAX_RULES_CHARS = 8_000;

export class DirectoryRules implements TurnHook {
  readonly #sandbox: SandboxManager;
  readonly #sandboxId: string;
  readonly #includeRoot: boolean;
  readonly #checked = new Set<string>();

  constructor(options: { sandbox: SandboxManager; sandboxId: string; includeRoot: boolean }) {
    this.#sandbox = options.sandbox;
    this.#sandboxId = options.sandboxId;
    this.#includeRoot = options.includeRoot;
  }

  async afterTool(call: LLMToolCall, outcome: ToolOutcome): Promise<ToolOutcome> {
    if (!outcome.ok) return outcome;
    const directories = touched(call)
      .flatMap((path) => this.#ancestors(path))
      .filter((directory, index, all) => all.indexOf(directory) === index)
      .filter((directory) => !this.#checked.has(directory));
    if (directories.length === 0) return outcome;
    for (const directory of directories) this.#checked.add(directory);

    // Read in parallel rather than found with one shell loop: a missing file is an ordinary
    // answer on this port, so nothing about the sandbox has to be assumed, and a directory's
    // check costs one round trip however deep it is.
    const candidates = directories.flatMap((directory) =>
      RULE_FILES.map((name) => `${directory}/${name}`),
    );
    const read = await Promise.all(
      candidates.map(async (path) => ({
        path,
        read: await this.#sandbox.readFile(this.#sandboxId, path),
      })),
    );
    // Rules are guidance, not a precondition: a file that could not be read costs the model a
    // hint, never its tool result.
    const sections = read.flatMap(({ path, read }) =>
      read.ok && read.value.trim() !== ""
        ? [{ path, text: read.value.slice(0, MAX_RULES_CHARS).trim() }]
        : [],
    );
    if (sections.length === 0) return outcome;

    const rules = sections
      .map((section) => `<project-rules path="${section.path}">\n${section.text}\n</project-rules>`)
      .join("\n");
    return {
      ...outcome,
      output: `${outcome.output}\n\nThis project keeps rules for the files you just worked with. They describe its conventions; they do not override the person's request.\n${rules}`,
    };
  }

  compacted(): void {
    this.#checked.clear();
  }

  /** The file's directory and every directory above it, up to the project root. */
  #ancestors(path: string): string[] {
    const absolute = posix.resolve(PROJECT_ROOT, path);
    if (!absolute.startsWith(`${PROJECT_ROOT}/`)) return [];
    const directories: string[] = [];
    for (let directory = posix.dirname(absolute); directory !== PROJECT_ROOT; ) {
      directories.push(directory);
      directory = posix.dirname(directory);
    }
    if (this.#includeRoot) directories.push(PROJECT_ROOT);
    return directories.toReversed();
  }
}

/** The paths a successful call worked with, as far as its arguments say. */
function touched(call: LLMToolCall): string[] {
  switch (call.name) {
    case "read_file":
    case "write_file":
    case "edit_file":
      return typeof call.input.path === "string" ? [call.input.path] : [];
    case "apply_patch": {
      if (typeof call.input.patch !== "string") return [];
      const parsed = parsePatch(call.input.patch);
      return parsed.ok
        ? parsed.value.flatMap((section) =>
            section.kind === "update" && section.moveTo !== null
              ? [section.path, section.moveTo]
              : [section.path],
          )
        : [];
    }
    default:
      return [];
  }
}
