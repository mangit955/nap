/**
 * Putting a task's directory back after a review, as the product puts a repository back to its
 * commit (ADR-0036 D2).
 *
 * The reviewer has no tool that writes, but its commands can: running the task's program to check
 * it can create the very file the hidden tests read. In the product the job's work is committed,
 * and the workspace is reset to that commit. A benchmark task's machine has no commit, so this
 * copies the task's directory before the review and, afterwards, puts back every file the review
 * wrote: a changed file from the copy, a new one removed.
 *
 * Two limits, both recorded rather than hidden. A directory over `COPY_LIMIT_KB` is not copied, so
 * what a review writes there is listed but stays. And a file a review deleted is not noticed, since
 * only what changed after the review began is looked for.
 */

import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import type { SandboxManager } from "@nap/shared/ports/sandbox-manager";
import { shellQuote } from "@nap/shared/shell";

/** The largest directory copied before a review: a tar of it is written and read once each. */
export const COPY_LIMIT_KB = 200 * 1024;

/** How many written files a review's record lists. Every one is put back, listed or not. */
export const WROTE_LIMIT = 20;

export type ReviewGuardPaths = {
  /** The task's directory, as the agent sees it. */
  root: string;
  /** Where the mark, the copy and the list go: outside the task's directory. */
  scratch: string;
};

const DEFAULT_PATHS: ReviewGuardPaths = { root: PROJECT_ROOT_PATH, scratch: "/tmp/nap-review" };

/** What `afterReview` found and did. */
export type ReviewGuardOutcome = {
  /** Files the review wrote, up to `WROTE_LIMIT`; `null` when that could not be read. */
  wrote: string[] | null;
  /** Whether what it wrote was put back. False when the directory was not copied. */
  restored: boolean;
};

/** Marks the review's start, and copies the task's directory if it is small enough to. */
export async function beforeReview(
  sandbox: SandboxManager,
  sandboxId: string,
  paths: ReviewGuardPaths = DEFAULT_PATHS,
): Promise<{ marked: boolean; copied: boolean }> {
  const scratch = shellQuote(paths.scratch);
  const command = [
    `rm -rf ${scratch} && mkdir -p ${scratch} && cd ${shellQuote(paths.root)}`,
    // The mark is taken after the copy, so the copy's own reads cannot make a file look written.
    `if [ "$(du -sk . | cut -f1)" -le ${COPY_LIMIT_KB} ] && tar -cf ${scratch}/copy.tar . 2>/dev/null; then echo copied; else rm -f ${scratch}/copy.tar; echo not-copied; fi`,
    `touch ${scratch}/start`,
  ].join(" && ");
  const result = await sandbox.exec(sandboxId, command);
  if (!result.ok || result.value.exitCode !== 0) return { marked: false, copied: false };
  return { marked: true, copied: result.value.stdout.trim() === "copied" };
}

/** Lists what the review wrote and, when there is a copy, puts each file back from it. */
export async function afterReview(
  sandbox: SandboxManager,
  sandboxId: string,
  before: { marked: boolean; copied: boolean },
  paths: ReviewGuardPaths = DEFAULT_PATHS,
): Promise<ReviewGuardOutcome> {
  if (!before.marked) return { wrote: null, restored: false };
  const scratch = shellQuote(paths.scratch);
  const command = [
    `cd ${shellQuote(paths.root)}`,
    `find . -path ./.git -prune -o -type f -newer ${scratch}/start -print > ${scratch}/wrote 2>/dev/null`,
    `head -n ${WROTE_LIMIT} ${scratch}/wrote`,
    ...(before.copied
      ? [
          // A file the copy has comes back as it was; one it lacks was new, and stays removed.
          `while IFS= read -r f; do rm -f -- "$f"; tar -xf ${scratch}/copy.tar -- "$f" 2>/dev/null || true; done < ${scratch}/wrote`,
        ]
      : []),
    `rm -rf ${scratch}`,
  ].join(" && ");
  const result = await sandbox.exec(sandboxId, command);
  if (!result.ok || result.value.exitCode !== 0) return { wrote: null, restored: false };
  return {
    wrote: result.value.stdout.split("\n").filter((line) => line !== ""),
    restored: before.copied,
  };
}
