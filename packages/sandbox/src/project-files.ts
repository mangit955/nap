/**
 * The project's files, as one bounded listing.
 *
 * A flat list of paths, rather than a folder at a time, is what lets the browser expand, collapse
 * and highlight a file it has never asked the server about — the alternative, a request per opened
 * folder, turns "a file changed three levels down" into a chain of round trips before it can be
 * shown.
 *
 * It is **one sandbox call**, `SandboxManager.listTree`. It used to be a `listFiles` per folder,
 * awaited one after another, every time the files panel opened or a file changed.
 *
 * Three properties matter more than completeness. The listing is **bounded** by entries, breadth
 * first: a generated project can nest without limit, and a file tree is a navigation aid, not an
 * inventory. It is **not bounded by depth**, which the walk was only because every folder it
 * opened was another round trip; a file the agent just changed eight folders down is one the
 * panel has to be able to show. And a listing that fails **fails**: the panel's caller has to be
 * able to tell a sandbox that did not answer from an empty project, which is the opposite of the
 * model's digest, where a missing hint is no reason to stop.
 *
 * Only files are returned; directories come back implied by the paths that pass through them.
 * An empty directory therefore does not appear, which is the one thing this shape gives up. A
 * repository's gitignored files do not appear either, which is `listTree`'s promise and what
 * somebody browsing their own project expects.
 *
 * The exclusion list below deliberately repeats the one in the context package's file-tree
 * digest rather than sharing it. That one is sized for a model's token budget and this one for
 * someone clicking through a tree; they agree today because the same directories are noise in
 * both, and nothing says they must stay in step. The walk that applies the cap is shared, because
 * there both want exactly the same thing.
 */

import { walkBreadthFirst } from "@nap/shared/list-tree";
import type { SandboxError, SandboxManager } from "@nap/shared/ports/sandbox-manager";
import type { Result } from "@nap/shared/result";
import { TEMPLATE_WORKDIR } from "./template.ts";

/** Vendored dependencies, build products and version-control internals — never the project. */
const EXCLUDED = ["node_modules", ".git", "dist", ".vite", ".next", "coverage"];

const DEFAULT_MAX_ENTRIES = 500;

/**
 * How long the listing may take before the panel is told the sandbox did not answer. Named, so the
 * provider's own default — a minute, on E2B — is never what somebody opening the panel waits out.
 * Longer than the digest's five seconds because a person is asking and there is nothing to fall
 * back to: a large imported repository's first `git ls-files` can take a few seconds cold.
 */
const LIST_TIMEOUT_MS = 10_000;

export type ProjectListing = {
  /** Project-root-relative, sorted. */
  paths: string[];
  /**
   * Whether the entry limit kept back a file the listing had. The shell adapter rejects listings
   * that reach its raw byte ceiling, because an incomplete input cannot preserve shallow files
   * or tell this caller what was excluded before the entry limit is applied.
   */
  truncated: boolean;
};

export type ListProjectFilesOptions = {
  root?: string;
  maxEntries?: number;
};

/**
 * Breadth-first, so a shallow entry is never displaced by a deep one when the limit bites:
 * `src/App.tsx` matters more than the tenth level of a nested component tree.
 *
 * Takes only the one method it uses, so a test can supply a sandbox that fails without standing
 * up a whole one.
 */
export async function listProjectFiles(
  sandbox: Pick<SandboxManager, "listTree">,
  sandboxId: string,
  opts: ListProjectFilesOptions = {},
): Promise<Result<ProjectListing, SandboxError>> {
  const root = opts.root ?? TEMPLATE_WORKDIR;

  const listed = await sandbox.listTree(sandboxId, root, {
    exclude: EXCLUDED,
    timeoutMs: LIST_TIMEOUT_MS,
  });
  // The root is the whole request: a failure here is nothing to show, not an empty project.
  if (!listed.ok) return listed;

  const walked = walkBreadthFirst(root, listed.value, {
    maxEntries: opts.maxEntries ?? DEFAULT_MAX_ENTRIES,
  });
  const prefix = root.endsWith("/") ? root : `${root}/`;

  return {
    ok: true,
    value: {
      paths: walked.paths
        .map((path) => path.slice(prefix.length))
        .sort((a, b) => a.localeCompare(b)),
      truncated: walked.truncated,
    },
  };
}
