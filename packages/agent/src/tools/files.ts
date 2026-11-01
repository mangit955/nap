/**
 * Reading, writing, editing and listing the project's files.
 *
 * Reads come back numbered, the way `cat -n` prints them, because a model that can say "line
 * 40" can ask for line 40 again with `offset` rather than re-reading the whole file. The numbers
 * are presentation: `edit_file` matches the file's own text, and its description says so.
 */

import { emit, failed, type ToolContext, type ToolOutcome } from "./context.ts";
import type { ToolArgs } from "./definitions.ts";
import { DEFAULT_READ_LINES } from "./definitions.ts";
import { fileChange } from "./diff.ts";

/** A minified bundle is one line; past this a line is cut rather than sent whole. */
export const MAX_LINE_CHARS = 2_000;

export async function readFile(
  args: ToolArgs<"read_file">,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const read = await ctx.sandbox.readFile(ctx.sandboxId, args.path);
  if (!read.ok) return failed(read.error);
  ctx.ledger?.remember(args.path);
  return { ok: true, output: numbered(read.value, args.offset ?? 1, args.limit) };
}

/**
 * The requested window of a file, each line prefixed with its number.
 *
 * Says what it left out, at both ends of the window, so a model reading the first two thousand
 * lines of a longer file knows there is more rather than concluding the file ends there.
 */
export function numbered(text: string, offset: number, limit = DEFAULT_READ_LINES): string {
  if (text === "") return "(empty file)";
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  if (offset > lines.length)
    return `The file has ${lines.length} lines; offset ${offset} is past the end.`;
  const window = lines.slice(offset - 1, offset - 1 + limit);
  const width = String(offset + window.length - 1).length;
  const body = window
    .map((line, index) => {
      const cut =
        line.length > MAX_LINE_CHARS
          ? `${line.slice(0, MAX_LINE_CHARS)}… (${line.length - MAX_LINE_CHARS} more characters)`
          : line;
      return `${String(offset + index).padStart(width, " ")}\t${cut}`;
    })
    .join("\n");
  const after = lines.length - (offset - 1 + window.length);
  return after > 0
    ? `${body}\n… ${after} more lines. Read on with offset ${offset + window.length}.`
    : body;
}

export async function writeFile(
  args: ToolArgs<"write_file">,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  // Read first, because whether this is a creation or a modification is only knowable
  // before the write, and the diff needs the old text either way.
  const existing = await ctx.sandbox.readFile(ctx.sandboxId, args.path);
  if (!existing.ok && existing.error.code !== "file_not_found") return failed(existing.error);
  const before = existing.ok ? existing.value : null;
  if (before !== null && ctx.ledger !== undefined && !ctx.ledger.knows(args.path))
    return unread(args.path, "overwriting");

  if (ctx.signal?.aborted) return { ok: false, output: "Cancelled before writing the file." };
  const written = await ctx.sandbox.writeFile(ctx.sandboxId, args.path, args.contents);
  if (!written.ok) return failed(written.error);

  ctx.ledger?.remember(args.path);
  emitChange(ctx, args.path, before, args.contents);
  return { ok: true, output: `Wrote ${args.path} (${args.contents.length} characters).` };
}

export async function editFile(
  args: ToolArgs<"edit_file">,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const read = await ctx.sandbox.readFile(ctx.sandboxId, args.path);
  if (!read.ok) return failed(read.error);
  if (ctx.ledger !== undefined && !ctx.ledger.knows(args.path)) return unread(args.path, "editing");

  const before = read.value;
  const occurrences = before.split(args.old_string).length - 1;

  if (occurrences === 0) {
    return {
      ok: false,
      output: `Nothing in ${args.path} matches:\n${args.old_string}\nRead the file and copy the text exactly, including whitespace and without the line numbers.`,
    };
  }
  if (occurrences > 1 && args.replace_all !== true) {
    // Editing the first of several is a coin flip on which one the model meant, and a
    // wrong edit is harder to notice than a refused one.
    return {
      ok: false,
      output: `That text appears ${occurrences} times in ${args.path}. Include enough surrounding lines to identify the one you mean, or set replace_all to change all ${occurrences}.`,
    };
  }

  // `split`/`join` rather than `replace`, whose replacement string treats `$&` and `$1` as
  // patterns — a model writing a shell snippet or a regex into a file would see it mangled.
  const after = before.split(args.old_string).join(args.new_string);
  if (ctx.signal?.aborted) return { ok: false, output: "Cancelled before editing the file." };
  const written = await ctx.sandbox.writeFile(ctx.sandboxId, args.path, after);
  if (!written.ok) return failed(written.error);

  emitChange(ctx, args.path, before, after);
  return {
    ok: true,
    output:
      occurrences === 1
        ? `Edited ${args.path}.`
        : `Edited ${args.path}: replaced ${occurrences} occurrences.`,
  };
}

export async function listFiles(
  args: ToolArgs<"list_files">,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const listed = await ctx.sandbox.listFiles(ctx.sandboxId, args.path);
  if (!listed.ok) return failed(listed.error);

  if (listed.value.length === 0) return { ok: true, output: `${args.path} is empty.` };

  // A trailing slash is how every directory listing anyone has read marks a directory.
  return {
    ok: true,
    output: listed.value
      .map((node) => (node.type === "directory" ? `${node.path}/` : node.path))
      .join("\n"),
  };
}

export function emitChange(
  ctx: ToolContext,
  path: string,
  before: string | null,
  after: string | null,
): void {
  emit(ctx, {
    type: "file.changed",
    payload: { path, ...fileChange(path, before, after) },
  });
}

function unread(path: string, doing: string): ToolOutcome {
  return {
    ok: false,
    output: `Read ${path} with read_file before ${doing} it. It exists, and this turn has not seen what it holds.`,
  };
}
