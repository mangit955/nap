/**
 * Keeps plan bookkeeping out of shipped source.
 *
 * The plan is tracked by task ID (`M0-3`, `M2-5`), and while writing a task it is very
 * natural to cite that ID in a comment — "emitted by M2-5", "one entry per failure mode
 * M2-6/M2-7/M2-8 can produce". It reads fine on the day it is written and badly forever
 * after: whoever opens the file next has a reference to a tracker they cannot resolve
 * from the code, and the comment describes *when* something was built rather than *why*
 * it is the way it is.
 *
 * So: no bare task IDs in the `src` directory of any package or app. References to the plan
 * *document* are still welcome and deliberately untouched by this rule — `docs/PLAN.md §5`
 * names something a reader can actually open. Cite the section, not the ticket.
 *
 * `test/` and `docs/` are exempt: `test/docs.ts` exists to parse task IDs, and the plan
 * and progress files are made of them.
 *
 * Kept pure — it takes file contents and returns violations — so it can be tested against
 * synthetic input as well as against the real workspace.
 */

export type SourceFile = {
  /** Repo-relative, e.g. `packages/shared/src/events.ts`. */
  path: string;
  contents: string;
};

export type CommentViolation = {
  path: string;
  line: number;
  taskId: string;
  reason: string;
};

/** Matches a task ID (`M0-3`, `M2-8`) that is not part of a longer word. */
const TASK_ID = /\bM\d-\d\b/g;

/** Only shipped source is checked; see the exemptions in the module doc above. */
export function isCheckedSourcePath(path: string): boolean {
  return /^(packages|apps)\/[^/]+\/src\//.test(path);
}

export function checkNoTaskIds(files: SourceFile[]): CommentViolation[] {
  const violations: CommentViolation[] = [];

  for (const { path, contents } of files) {
    if (!isCheckedSourcePath(path)) continue;

    const lines = contents.split("\n");
    for (const [index, line] of lines.entries()) {
      for (const match of line.matchAll(TASK_ID)) {
        violations.push({
          path,
          line: index + 1,
          taskId: match[0],
          reason:
            `${path}:${index + 1} cites task ${match[0]}. Task IDs are plan bookkeeping and ` +
            "mean nothing to someone reading this file. Say why the code is the way it is, " +
            "or cite a section of docs/PLAN.md that a reader can open.",
        });
      }
    }
  }

  return violations;
}
