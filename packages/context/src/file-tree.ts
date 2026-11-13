/**
 * A listing of the project's files, for the model to orient itself by.
 *
 * Without it the agent's first move on every turn is a handful of `list_files` calls to
 * rediscover a layout that has not changed, which costs a round trip each and lands in the
 * conversation as noise. Handing over the shape of the project up front replaces all of that
 * with a few hundred tokens.
 *
 * Three properties matter more than completeness. The listing is **one sandbox call** — it runs
 * before anything reaches the model on every turn, every repair and every rebuild after
 * compaction, and it used to be a round trip per folder, one after another. What reaches the
 * prompt is **bounded** by entries and depth, breadth first. And a listing that fails or times
 * out **degrades rather than fails**: a missing hint is not a reason to end a turn the user
 * asked for, and the agent can always list the project itself.
 */

import { walkBreadthFirst } from "@nap/shared/list-tree";
import { getLogger } from "@nap/shared/logging";
import type { SandboxManager } from "@nap/shared/ports/sandbox-manager";

/**
 * Never worth showing the model: vendored dependencies and build products it must not edit,
 * and version-control internals it cannot use. Each of these is also enormous, so walking
 * them would exhaust the entry budget before reaching any of the project's own code.
 */
const EXCLUDED = new Set(["node_modules", ".git", "dist", ".vite", ".next", "coverage"]);

const DEFAULT_ROOT = "/home/user/app";
const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_MAX_DEPTH = 6;

/**
 * How long the listing may take. Set here rather than left to the provider, whose default on E2B
 * is a minute — a minute of nothing before the first token, on every turn, for a hint.
 */
const LIST_TIMEOUT_MS = 5_000;

/** What the model is told when the listing could not be had, so it does not read an empty project. */
export const FILE_LIST_UNAVAILABLE =
  "The file listing is unavailable this turn; list the project yourself if you need it.";

export type FileTreeDigestOptions = {
  root?: string;
  maxEntries?: number;
  maxDepth?: number;
};

/**
 * Breadth-first, so a shallow entry is never displaced by a deep one when the limit bites:
 * `src/App.tsx` matters more than the tenth level of a nested component tree.
 *
 * The walk and its limits are the ones that used to make a sandbox call per folder, now reading
 * folders out of a single listing (`walkBreadthFirst`). What that listing holds is not quite what
 * the old walk saw: a repository's gitignored files are left out by design, the fallback for a
 * workspace without git lists regular files only — no symlinks. A listing that reaches its raw
 * byte ceiling is unavailable rather than a partial prefix that could hide shallow files.
 */
export async function buildFileTreeDigest(
  sandbox: SandboxManager,
  sandboxId: string,
  opts: FileTreeDigestOptions = {},
): Promise<string> {
  const root = opts.root ?? DEFAULT_ROOT;
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;

  const listed = await sandbox.listTree(sandboxId, root, {
    exclude: [...EXCLUDED],
    timeoutMs: LIST_TIMEOUT_MS,
  });
  // A failure here is a gap, not an error — see the note above. Logged, because a listing that
  // fails on every turn would otherwise show up nowhere but in what the model was told. The code
  // only: the message names the project's path.
  if (!listed.ok) {
    getLogger().warn({ code: listed.error.code }, "the file listing was unavailable");
    return FILE_LIST_UNAVAILABLE;
  }
  // Sorted within each folder, so the same project always renders the same bytes, which is what
  // lets a request that carries it repeat the one before it.
  const { paths } = walkBreadthFirst(root, listed.value, { maxEntries, maxDepth });

  if (paths.length === 0) return "";

  const prefix = root.endsWith("/") ? root : `${root}/`;
  return paths
    .map((path) => `- ${path.startsWith(prefix) ? path.slice(prefix.length) : path}`)
    .join("\n");
}
