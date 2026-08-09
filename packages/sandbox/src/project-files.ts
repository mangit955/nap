/**
 * The project's files, as one bounded listing.
 *
 * `listFiles` returns direct children only, so anything that wants a tree has to walk. Doing
 * that walk once per request and handing back a flat list of paths is what lets the browser
 * expand, collapse and highlight a file it has never asked the server about — the alternative,
 * a request per opened folder, turns "a file changed three levels down" into a chain of round
 * trips before it can be shown.
 *
 * Two properties matter more than completeness. The walk is **bounded**: a generated project
 * can nest without limit, and a file tree is a navigation aid, not an inventory. And a
 * directory that cannot be read **degrades rather than fails** — one unreadable folder is a
 * gap in a listing, while a failure at the root means there is nothing to show at all, which
 * the caller has to be able to tell apart from an empty project.
 *
 * Only files are returned; directories come back implied by the paths that pass through them.
 * An empty directory therefore does not appear, which is the one thing this shape gives up.
 *
 * The exclusion list below deliberately repeats the one in the context package's file-tree
 * digest rather than sharing it. That one is sized for a model's token budget and this one for
 * someone clicking through a tree; they agree today because the same directories are noise in
 * both, and nothing says they must stay in step.
 */

import type { SandboxError, SandboxManager } from "@nap/shared/ports/sandbox-manager";
import type { Result } from "@nap/shared/result";
import { TEMPLATE_WORKDIR } from "./template.ts";

/** Vendored dependencies, build products and version-control internals — never the project. */
const EXCLUDED = new Set(["node_modules", ".git", "dist", ".vite", ".next", "coverage"]);

const DEFAULT_MAX_ENTRIES = 500;
const DEFAULT_MAX_DEPTH = 6;

export type ProjectListing = {
  /** Project-root-relative, sorted. */
  paths: string[];
  /** Whether a limit stopped the walk before it ran out of project. */
  truncated: boolean;
};

export type ListProjectFilesOptions = {
  root?: string;
  maxEntries?: number;
  maxDepth?: number;
};

function basename(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut === -1 ? path : path.slice(cut + 1);
}

/**
 * Breadth-first, so a shallow entry is never displaced by a deep one when a limit bites:
 * `src/App.tsx` matters more than the tenth level of a nested component tree.
 *
 * Takes only the one method it uses, so a test can supply a directory that fails without
 * standing up a whole sandbox.
 */
export async function listProjectFiles(
  sandbox: Pick<SandboxManager, "listFiles">,
  sandboxId: string,
  opts: ListProjectFilesOptions = {},
): Promise<Result<ProjectListing, SandboxError>> {
  const root = opts.root ?? TEMPLATE_WORKDIR;
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;

  const paths: string[] = [];
  let queue: string[] = [root];
  let truncated = false;

  for (let depth = 0; depth <= maxDepth && queue.length > 0; depth += 1) {
    const next: string[] = [];

    for (const directory of queue) {
      if (paths.length >= maxEntries) {
        truncated = true;
        break;
      }

      const listed = await sandbox.listFiles(sandboxId, directory);

      if (!listed.ok) {
        // The root is the whole request; anything below it is one branch of it.
        if (directory === root) return listed;
        truncated = true;
        continue;
      }

      for (const child of listed.value) {
        if (EXCLUDED.has(basename(child.path))) continue;

        if (child.type === "directory") {
          next.push(child.path);
          continue;
        }

        if (paths.length >= maxEntries) {
          truncated = true;
          break;
        }
        paths.push(child.path);
      }
    }

    // Directories the depth limit stopped us from opening are project the caller is not
    // being shown, and it has to be able to say so.
    if (depth === maxDepth && next.length > 0) truncated = true;

    queue = next;
  }

  const prefix = root.endsWith("/") ? root : `${root}/`;

  return {
    ok: true,
    value: {
      paths: paths
        .map((path) => (path.startsWith(prefix) ? path.slice(prefix.length) : path))
        .sort((a, b) => a.localeCompare(b)),
      truncated,
    },
  };
}
