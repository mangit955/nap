/**
 * The patch format GPT models are trained to edit with, parsed and applied here.
 *
 * It is not a unified diff: hunks carry no line numbers, only context, and a file section says
 * outright whether it adds, updates, moves or deletes. That is what makes it robust to a model
 * that cannot count lines, and it is why applying one is a search rather than an offset.
 *
 * **All or nothing.** Every section is parsed and every hunk located before anything is written,
 * so a patch whose third hunk does not match changes no file at all. A half-applied patch is
 * worse than a refused one: the model's picture of the tree is then wrong in a way it was not
 * told about.
 *
 * Matching tolerates what models get wrong without changing what they meant — trailing
 * whitespace first, then indentation — and nothing looser. A hunk that matches only after both
 * are ignored is still applied at a unique, ordered location, or not at all.
 */

import { posix } from "node:path";
import type { Result } from "@nap/shared/result";
import { shellQuote } from "@nap/shared/shell";
import { failed, type ToolContext, type ToolOutcome } from "./context.ts";
import { PROJECT_ROOT, type ToolArgs } from "./definitions.ts";
import { emitChange } from "./files.ts";

export type Hunk = {
  /** The `@@` line's text, which names a line to find before looking for the context. */
  anchor: string | null;
  before: string[];
  after: string[];
  /** `*** End of File` followed it: the context must be the file's last lines. */
  atEnd: boolean;
};

export type PatchSection =
  | { kind: "add"; path: string; contents: string }
  | { kind: "delete"; path: string }
  | { kind: "update"; path: string; moveTo: string | null; hunks: Hunk[] };

const BEGIN = "*** Begin Patch";
const END = "*** End Patch";
const ADD = "*** Add File: ";
const DELETE = "*** Delete File: ";
const UPDATE = "*** Update File: ";
const MOVE = "*** Move to: ";
const END_OF_FILE = "*** End of File";

export function parsePatch(text: string): Result<PatchSection[], string> {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  // Some models fence the patch or wrap it in a heredoc; the markers inside are what count.
  const start = lines.findIndex((line) => line.trim() === BEGIN);
  const stop = lines.findLastIndex((line) => line.trim() === END);
  if (start === -1) return { ok: false, error: `The patch must start with "${BEGIN}".` };
  if (stop <= start) return { ok: false, error: `The patch must end with "${END}".` };

  const sections: PatchSection[] = [];
  let i = start + 1;
  while (i < stop) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i += 1;
      continue;
    }
    if (line.startsWith(ADD)) {
      const path = line.slice(ADD.length).trim();
      const body: string[] = [];
      i += 1;
      while (i < stop && !isHeader(lines[i] ?? "")) {
        const added = lines[i] ?? "";
        if (!added.startsWith("+"))
          return { ok: false, error: `Every line of an added file starts with "+" (${path}).` };
        body.push(added.slice(1));
        i += 1;
      }
      sections.push({
        kind: "add",
        path,
        contents: body.length === 0 ? "" : `${body.join("\n")}\n`,
      });
      continue;
    }
    if (line.startsWith(DELETE)) {
      sections.push({ kind: "delete", path: line.slice(DELETE.length).trim() });
      i += 1;
      continue;
    }
    if (line.startsWith(UPDATE)) {
      const path = line.slice(UPDATE.length).trim();
      i += 1;
      let moveTo: string | null = null;
      if ((lines[i] ?? "").startsWith(MOVE)) {
        moveTo = (lines[i] ?? "").slice(MOVE.length).trim();
        i += 1;
      }
      const hunks: Hunk[] = [];
      let current: Hunk | null = null;
      while (i < stop && !isHeader(lines[i] ?? "")) {
        const body = lines[i] ?? "";
        if (body.startsWith("@@")) {
          current = { anchor: body.slice(2).trim() || null, before: [], after: [], atEnd: false };
          hunks.push(current);
        } else if (body.trim() === END_OF_FILE) {
          if (current === null)
            return { ok: false, error: `"${END_OF_FILE}" outside a hunk (${path}).` };
          current.atEnd = true;
        } else {
          // The first hunk may omit its `@@` line; a blank line is unchanged context, since
          // models routinely drop the single space that should prefix it.
          if (current === null) {
            current = { anchor: null, before: [], after: [], atEnd: false };
            hunks.push(current);
          }
          const marker = body[0] ?? " ";
          const content = body.slice(1);
          if (marker === " " || body === "") {
            current.before.push(content);
            current.after.push(content);
          } else if (marker === "-") current.before.push(content);
          else if (marker === "+") current.after.push(content);
          else
            return {
              ok: false,
              error: `Hunk lines start with " ", "-" or "+"; got ${JSON.stringify(body)} in ${path}.`,
            };
        }
        i += 1;
      }
      if (hunks.length === 0 && moveTo === null)
        return { ok: false, error: `"${UPDATE}${path}" has no changes.` };
      sections.push({ kind: "update", path, moveTo, hunks });
      continue;
    }
    return { ok: false, error: `Expected a file header, got ${JSON.stringify(line)}.` };
  }
  if (sections.length === 0) return { ok: false, error: "The patch changes no files." };
  return { ok: true, value: sections };
}

function isHeader(line: string): boolean {
  return line.startsWith(ADD) || line.startsWith(DELETE) || line.startsWith(UPDATE);
}

/** The levels of forgiveness, strictest first. Each is tried over the whole file before the next. */
const NORMALIZERS: readonly ((line: string) => string)[] = [
  (line) => line,
  (line) => line.trimEnd(),
  (line) => line.trim(),
];

/**
 * Applies one file's hunks in order, each searched for after the end of the one before.
 *
 * Returns the new text or which hunk could not be placed, quoting its context so the model can
 * see what it claimed the file said.
 */
export function applyHunks(original: string, hunks: readonly Hunk[]): Result<string, string> {
  const trailingNewline = original.endsWith("\n");
  const lines =
    original === "" ? [] : (trailingNewline ? original.slice(0, -1) : original).split("\n");
  let cursor = 0;
  for (const [index, hunk] of hunks.entries()) {
    let from = cursor;
    if (hunk.anchor !== null) {
      const anchor = find(lines, [hunk.anchor], cursor, false);
      if (anchor === undefined)
        return { ok: false, error: `Hunk ${index + 1}: could not find the line "${hunk.anchor}".` };
      from = anchor + 1;
    }
    // A pure insertion with no context goes where the anchor put it, or at the end.
    if (hunk.before.length === 0) {
      const at = hunk.anchor === null || hunk.atEnd ? lines.length : from;
      lines.splice(at, 0, ...hunk.after);
      cursor = at + hunk.after.length;
      continue;
    }
    const at = find(lines, hunk.before, from, hunk.atEnd);
    if (at === undefined)
      return {
        ok: false,
        error: `Hunk ${index + 1}: these lines are not in the file${hunk.anchor === null ? "" : ` after "${hunk.anchor}"`}:\n${hunk.before.join("\n")}`,
      };
    lines.splice(at, hunk.before.length, ...hunk.after);
    cursor = at + hunk.after.length;
  }
  if (lines.length === 0) return { ok: true, value: "" };
  return {
    ok: true,
    value: `${lines.join("\n")}${trailingNewline || original === "" ? "\n" : ""}`,
  };
}

/**
 * The first place at or after `from` where `wanted` appears, at the strictest level that finds
 * it. `atEnd` requires the match to finish on the file's last line.
 */
function find(
  lines: readonly string[],
  wanted: readonly string[],
  from: number,
  atEnd: boolean,
): number | undefined {
  for (const normalize of NORMALIZERS) {
    const target = wanted.map(normalize);
    const last = lines.length - target.length;
    for (let start = atEnd ? last : from; start >= from && start <= last; start += 1) {
      if (target.every((line, offset) => normalize(lines[start + offset] ?? "") === line))
        return start;
    }
  }
  return undefined;
}

type Planned = { path: string; before: string | null; after: string | null };

export async function applyPatch(
  args: ToolArgs<"apply_patch">,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const parsed = parsePatch(args.patch);
  if (!parsed.ok) return { ok: false, output: `${parsed.error} Nothing was changed.` };

  // Every file is read and every hunk placed before the first write.
  const planned: Planned[] = [];
  for (const section of parsed.value) {
    const path = resolve(section.path);
    // Each section reads the tree as it was, so a second section on the same file would undo
    // the first. Models write one section per file; refusing the other shape keeps that true.
    if (planned.some((change) => change.path === path))
      return refuse(`${path} appears in more than one section. Put all its changes in one.`);
    const read = await ctx.sandbox.readFile(ctx.sandboxId, path);
    if (!read.ok && read.error.code !== "file_not_found") return failed(read.error);
    const existing = read.ok ? read.value : null;

    if (section.kind === "add") {
      if (existing !== null)
        return refuse(`${path} already exists. Update it instead of adding it.`);
      planned.push({ path, before: null, after: section.contents });
      continue;
    }
    if (existing === null) return refuse(`${path} does not exist.`);
    if (section.kind === "delete") {
      planned.push({ path, before: existing, after: null });
      continue;
    }
    const applied = applyHunks(existing, section.hunks);
    if (!applied.ok) return refuse(`${path}: ${applied.error}`);
    if (section.moveTo === null) planned.push({ path, before: existing, after: applied.value });
    else {
      const target = resolve(section.moveTo);
      const occupied = await ctx.sandbox.readFile(ctx.sandboxId, target);
      if (occupied.ok) return refuse(`${target} already exists, so ${path} cannot move there.`);
      if (occupied.error.code !== "file_not_found") return failed(occupied.error);
      planned.push({ path, before: existing, after: null });
      planned.push({ path: target, before: null, after: applied.value });
    }
  }

  for (const change of planned) {
    if (change.after === null) {
      const removed = await ctx.sandbox.exec(ctx.sandboxId, `rm -f -- ${shellQuote(change.path)}`);
      if (!removed.ok) return failed(removed.error);
      ctx.ledger?.forget(change.path);
    } else {
      const written = await ctx.sandbox.writeFile(ctx.sandboxId, change.path, change.after);
      if (!written.ok) return failed(written.error);
      ctx.ledger?.remember(change.path);
    }
    emitChange(ctx, change.path, change.before, change.after);
  }

  return {
    ok: true,
    output: planned
      .map(
        (change) =>
          `${change.after === null ? "Deleted" : change.before === null ? "Added" : "Updated"} ${change.path}`,
      )
      .join("\n"),
  };
}

function resolve(path: string): string {
  return posix.resolve(PROJECT_ROOT, path);
}

function refuse(reason: string): ToolOutcome {
  return {
    ok: false,
    output: `${reason} Nothing was changed; fix the patch and send all of it again.`,
  };
}
