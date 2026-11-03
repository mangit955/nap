/**
 * Listing a workspace's files with one shell command, for any sandbox that has a shell.
 *
 * `SandboxManager.listTree` promises one call, and on a sandbox reached over the network that
 * means one command. It lives here rather than in one adapter because every implementation
 * with a real shell — E2B, the local Docker desktop, the test sandbox that runs real bash —
 * must answer the same question the same way, and three copies of a quoting-sensitive command
 * line would be three chances to get it wrong.
 *
 * Git answers first, because it already knows what the project ignores and includes files
 * nobody has committed yet. A workspace that is not a repository, or a git that fails for any
 * reason, prints nothing and exits non-zero, and `find` answers instead — inside the same
 * command, so the fallback costs no second round trip. Output is NUL-separated on both
 * branches: a path may hold a space, a quote, a non-ASCII name or a newline, and a NUL is the
 * one byte none of them can.
 *
 * Git's index is not the disk, though. A file the agent deleted or moved this turn keeps its
 * index entry until the turn commits, so `--cached` alone would list a path that is gone, and a
 * moved file twice. The git branch therefore prints what the index has that the disk does not
 * first, then an empty record — two NULs in a row, which no path can produce — then the listing,
 * and the parser takes the first part away from the second. Deleted paths come first so that the
 * byte ceiling, which cuts from the end, can only ever cut the listing — and within the listing,
 * the files the project tracks come before the ones it does not, so the ceiling cuts untracked
 * files before any tracked one.
 */

import type { ExecResult, SandboxError, SandboxManager } from "./ports/sandbox-manager.ts";
import type { Result } from "./result.ts";
import { shellQuote } from "./shell.ts";

/**
 * A ceiling on what one listing may print. Roughly twenty thousand paths: an imported monorepo
 * can hold far more, and a listing that size is a megabyte of transfer for a digest that shows
 * two hundred of them. A cut listing is still a listing — the parser drops the partial tail.
 */
const MAX_OUTPUT_BYTES = 1_048_576;

/**
 * The command that lists every file under `root`, relative to it, NUL-separated.
 *
 * Tracked and untracked files are two git calls, tracked first. One call with both flags prints
 * the untracked ones first, so an unignored `vendor/` or `build/` of any size would fill the byte
 * ceiling and cut every file the project actually owns. `--exclude` reaches the untracked call as
 * well as `find`, because git walks untracked folders whatever the parser later throws away, and a
 * `node_modules` nobody listed in `.gitignore` is a long walk for nothing. A pattern with no slash
 * matches a name at any depth, as `-name` does.
 *
 * `maxBytes` is a parameter only so a test can reach the ceiling with a handful of files.
 */
export function listTreeCommand(
  root: string,
  exclude: readonly string[],
  maxBytes: number = MAX_OUTPUT_BYTES,
): string {
  const pruned =
    exclude.length === 0
      ? ""
      : `\\( ${exclude.map((name) => `-name ${shellQuote(name)}`).join(" -o ")} \\) -prune -o `;
  const excluded = exclude.map((name) => ` --exclude=${shellQuote(name)}`).join("");
  const git =
    "{ git ls-files -z --deleted && printf '\\0' && git ls-files -z --cached && " +
    `git ls-files -z --others --exclude-standard${excluded}; } 2>/dev/null`;
  const find = `find . -mindepth 1 ${pruned}-type f -print0`;
  return `cd ${shellQuote(root)} && { ${git} || ${find}; } | head -c ${maxBytes}`;
}

/**
 * Absolute paths from what the command printed, without duplicates, excluded segments, or files
 * the disk no longer has.
 *
 * Duplicates, because git lists a conflicted path once per merge stage. Excluded segments are
 * filtered here as well as left out by the command, because git lists anything that is
 * committed, and a committed `dist/` is still a build product nobody should be shown. Missing
 * files, because the git branch lists the index: whatever precedes its empty record is what the
 * index has and the disk does not. `find` prints no empty record, so its output is all listing.
 */
export function parseListTree(root: string, stdout: string, exclude: readonly string[]): string[] {
  const records = stdout.split("\0");
  // The last record is complete only if the output ended on a separator; otherwise the byte
  // ceiling cut it, and half a path is worse than no path.
  records.pop();
  const separator = records.indexOf("");
  const deleted = new Set(separator === -1 ? [] : records.slice(0, separator));
  const listing = separator === -1 ? records : records.slice(separator + 1);
  const excluded = new Set(exclude);
  const prefix = root.endsWith("/") ? root : `${root}/`;
  const paths = new Set<string>();
  for (const record of listing) {
    const relative = record.startsWith("./") ? record.slice(2) : record;
    if (relative === "" || deleted.has(relative)) continue;
    if (relative.split("/").some((segment) => excluded.has(segment))) continue;
    paths.add(`${prefix}${relative}`);
  }
  return [...paths];
}

/** `listTree` for any sandbox whose `exec` reaches a real shell: one command, parsed. */
export async function listTreeViaExec(
  sandbox: Pick<SandboxManager, "exec">,
  sandboxId: string,
  root: string,
  options: { exclude: readonly string[]; timeoutMs: number },
): Promise<Result<string[], SandboxError>> {
  const ran: Result<ExecResult, SandboxError> = await sandbox.exec(
    sandboxId,
    listTreeCommand(root, options.exclude),
    undefined,
    // Stopped, not just abandoned, at the deadline: otherwise the provider kills only the shell
    // it started and a `git` or `find` over a large tree carries on for nobody.
    { timeoutMs: options.timeoutMs, stopOnGiveUp: true },
  );
  if (!ran.ok) return ran;
  // `head` decides the pipeline's status, so a non-zero exit is usually the `cd` — no such root.
  // Not only that, though: a provider can report a shell it killed as a negative exit, and a
  // profile that sets `pipefail` makes a cut-off `git` fail the pipeline. Whichever it was, what
  // came out is not a listing anybody should trust.
  if (ran.value.exitCode !== 0) {
    return {
      ok: false,
      error: {
        code: ran.value.exitCode < 0 ? "exec_failed" : "file_not_found",
        message: `cannot list ${root}: exit ${ran.value.exitCode} ${ran.value.stderr.trim()}`,
      },
    };
  }
  return { ok: true, value: parseListTree(root, ran.value.stdout, options.exclude) };
}
