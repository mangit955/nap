/**
 * Finding files by name and by content.
 *
 * Both skip `node_modules` and `.git`: the first is baked into the image and a hit there is
 * never the answer, the second is git's and not the project's.
 *
 * Content search prefers ripgrep and falls back to grep, decided inside the sandbox on every
 * call rather than assumed: the project template does not install ripgrep, an imported
 * repository's image might, and the two agree on everything the arguments here can ask for —
 * extended regular expressions, a file-name filter, case, matching files only. Both say "found
 * nothing" with exit 1, which is an answer rather than a failure.
 */

import { shellQuote } from "@nap/shared/shell";
import { failed, type ToolContext, type ToolOutcome } from "./context.ts";
import { PROJECT_ROOT, type ToolArgs } from "./definitions.ts";

/** More matches than this is a pattern too broad to be useful, and the model is told so. */
export const MAX_GLOB_MATCHES = 500;

export async function globFiles(args: ToolArgs<"glob">, ctx: ToolContext): Promise<ToolOutcome> {
  let matcher: (path: string) => boolean;
  try {
    matcher = globMatcher(args.pattern);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return { ok: false, output: `Invalid glob ${args.pattern}: ${error.message}` };
  }
  const base = (args.path ?? PROJECT_ROOT).replace(/\/+$/, "") || "/";
  const command = `cd ${shellQuote(base)} && find . \\( -name node_modules -o -name .git \\) -prune -o -type f -print`;
  const executed = await ctx.sandbox.exec(ctx.sandboxId, command, undefined, {
    signal: ctx.signal,
  });
  if (!executed.ok) return failed(executed.error);
  if (executed.value.exitCode !== 0)
    return { ok: false, output: executed.value.stderr || `Could not list files under ${base}.` };

  const matches = executed.value.stdout
    .split("\n")
    .filter((line) => line.startsWith("./"))
    .map((line) => line.slice(2))
    .filter(matcher)
    .toSorted();
  if (matches.length === 0)
    return { ok: true, output: `No files match ${args.pattern} under ${base}.` };
  const shown = matches.slice(0, MAX_GLOB_MATCHES).map((relative) => `${base}/${relative}`);
  return {
    ok: true,
    output:
      matches.length > MAX_GLOB_MATCHES
        ? `${shown.join("\n")}\n… ${matches.length - MAX_GLOB_MATCHES} more. Narrow the pattern.`
        : shown.join("\n"),
  };
}

/**
 * A predicate over slash-separated relative paths.
 *
 * `**` crosses directories, `*` and `?` do not, `{a,b}` is alternation and `[...]` a class. A
 * pattern with no slash matches a file's name at any depth — `*.tsx` finds every component, which
 * is what anybody typing it means — the way `.gitignore` and ripgrep's `-g` read one.
 */
export function globMatcher(pattern: string): (path: string) => boolean {
  const anchored = pattern.includes("/");
  const expression = new RegExp(`^${translate(pattern.replace(/^\.\//, ""))}$`);
  return (path) => expression.test(anchored ? path : (path.split("/").at(-1) ?? path));
}

function translate(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i] ?? "";
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        // `**/` matches zero or more whole directories; a bare `**` matches anything at all.
        if (pattern[i + 2] === "/") {
          out += "(?:.*/)?";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else out += "[^/]*";
    } else if (char === "?") out += "[^/]";
    else if (char === "{") {
      const close = pattern.indexOf("}", i);
      if (close === -1) out += "\\{";
      else {
        out += `(?:${pattern
          .slice(i + 1, close)
          .split(",")
          .map(translate)
          .join("|")})`;
        i = close;
      }
    } else if (char === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) out += "\\[";
      else {
        const body = pattern
          .slice(i + 1, close)
          .replace(/^!/, "^")
          .replace(/\\/g, "\\\\");
        out += `[${body}]`;
        i = close;
      }
    } else out += char.replace(/[.+^$()|\\]/g, "\\$&");
  }
  return out;
}

export async function searchFiles(
  args: ToolArgs<"search_files">,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const target = args.path ?? PROJECT_ROOT;
  // Every argument is quoted: the pattern is written by a model relaying whatever a user
  // typed, and unquoted it is a command line rather than a search.
  const pattern = shellQuote(args.pattern);
  const path = shellQuote(target);
  const rg = [
    "rg -n --hidden --no-heading --color=never --max-columns=400",
    "--glob '!node_modules' --glob '!.git'",
    args.ignore_case === true ? "-i" : "",
    args.files_only === true ? "-l" : "",
    args.glob === undefined ? "" : `--glob ${shellQuote(args.glob)}`,
    `-e ${pattern} -- ${path}`,
  ];
  const grep = [
    "grep -rnIE --exclude-dir=node_modules --exclude-dir=.git",
    args.ignore_case === true ? "-i" : "",
    args.files_only === true ? "-l" : "",
    args.glob === undefined ? "" : `--include=${shellQuote(args.glob)}`,
    `-e ${pattern} -- ${path}`,
  ];
  const command = `if command -v rg >/dev/null 2>&1; then ${words(rg)}; else ${words(grep)}; fi`;

  const executed = await ctx.sandbox.exec(ctx.sandboxId, command, undefined, {
    signal: ctx.signal,
  });
  if (!executed.ok) return failed(executed.error);

  const { exitCode, stdout, stderr } = executed.value;
  // Both tools say "found nothing" with exit 1. That is an answer to the question asked.
  if (exitCode === 1) return { ok: true, output: `No matches for ${args.pattern} in ${target}.` };
  if (exitCode !== 0) return { ok: false, output: stderr || `search exited ${exitCode}.` };

  return { ok: true, output: stdout };
}

function words(parts: readonly string[]): string {
  return parts.filter((part) => part !== "").join(" ");
}
