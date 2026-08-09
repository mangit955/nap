/**
 * A listing of the project's files, for the model to orient itself by.
 *
 * Without it the agent's first move on every turn is a handful of `list_files` calls to
 * rediscover a layout that has not changed, which costs a round trip each and lands in the
 * conversation as noise. Handing over the shape of the project up front replaces all of that
 * with a few hundred tokens.
 *
 * Two properties matter more than completeness. The walk is **bounded before the budget sees
 * it** — a generated project can nest without limit, and discovering that by assembling a
 * megabyte of paths and then throwing most of it away would make every turn slow. And a
 * directory that cannot be listed **degrades rather than fails**: an unreadable folder is a
 * gap in a hint, not a reason to end a turn the user asked for, and the agent can always
 * list it itself.
 */

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

export type FileTreeDigestOptions = {
  root?: string;
  maxEntries?: number;
  maxDepth?: number;
};

function basename(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? path : path.slice(cut + 1);
}

/**
 * Breadth-first, so a shallow entry is never displaced by a deep one when the limit bites:
 * `src/App.tsx` matters more than the tenth level of a nested component tree.
 */
export async function buildFileTreeDigest(
  sandbox: SandboxManager,
  sandboxId: string,
  opts: FileTreeDigestOptions = {},
): Promise<string> {
  const root = opts.root ?? DEFAULT_ROOT;
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;

  const paths: string[] = [];
  let queue: string[] = [root];

  for (let depth = 0; depth <= maxDepth && queue.length > 0; depth += 1) {
    const next: string[] = [];

    for (const directory of queue) {
      if (paths.length >= maxEntries) break;

      const listed = await sandbox.listFiles(sandboxId, directory);
      // A failure here is a gap, not an error — see the note above.
      if (!listed.ok) continue;

      // Sorted so the same project always renders the same bytes; the digest sits inside a
      // prefix the provider caches, and an unstable order would defeat that every turn.
      const children = [...listed.value].sort((a, b) => a.path.localeCompare(b.path));

      for (const child of children) {
        if (paths.length >= maxEntries) break;
        if (EXCLUDED.has(basename(child.path))) continue;

        if (child.type === "directory") {
          next.push(child.path);
          continue;
        }
        paths.push(child.path);
      }
    }

    queue = next;
  }

  if (paths.length === 0) return "";

  const prefix = root.endsWith("/") ? root : `${root}/`;
  return paths
    .map((path) => `- ${path.startsWith(prefix) ? path.slice(prefix.length) : path}`)
    .join("\n");
}
