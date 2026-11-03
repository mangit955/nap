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

/** The command that lists every file under `root`, relative to it, NUL-separated. */
export function listTreeCommand(root: string, exclude: readonly string[]): string {
  const pruned =
    exclude.length === 0
      ? ""
      : `\\( ${exclude.map((name) => `-name ${shellQuote(name)}`).join(" -o ")} \\) -prune -o `;
  const git = "git ls-files -z --cached --others --exclude-standard 2>/dev/null";
  const find = `find . -mindepth 1 ${pruned}-type f -print0`;
  return `cd ${shellQuote(root)} && { ${git} || ${find}; } | head -c ${MAX_OUTPUT_BYTES}`;
}

/**
 * Absolute paths from what the command printed, without duplicates or excluded segments.
 *
 * Duplicates, because git lists a conflicted path once per merge stage. Excluded segments are
 * filtered here as well as pruned in `find`, because git lists anything that is committed, and
 * a committed `dist/` is still a build product nobody should be shown.
 */
export function parseListTree(root: string, stdout: string, exclude: readonly string[]): string[] {
  const records = stdout.split("\0");
  // The last record is complete only if the output ended on a separator; otherwise the byte
  // ceiling cut it, and half a path is worse than no path.
  records.pop();
  const excluded = new Set(exclude);
  const prefix = root.endsWith("/") ? root : `${root}/`;
  const paths = new Set<string>();
  for (const record of records) {
    const relative = record.startsWith("./") ? record.slice(2) : record;
    if (relative === "") continue;
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
    { timeoutMs: options.timeoutMs },
  );
  if (!ran.ok) return ran;
  // `head` decides the pipeline's status, so a non-zero exit here is the `cd` — no such root.
  if (ran.value.exitCode !== 0) {
    return {
      ok: false,
      error: { code: "file_not_found", message: `cannot list ${root}: ${ran.value.stderr.trim()}` },
    };
  }
  return { ok: true, value: parseListTree(root, ran.value.stdout, options.exclude) };
}
