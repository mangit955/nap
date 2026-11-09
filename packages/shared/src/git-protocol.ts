import { z } from "zod";

/**
 * Lines one commit added and removed, as git's own `--shortstat` counted them. Recorded on
 * `turn.completed` when the turn commits, and read back by the session sidebar's card.
 */
export const DiffStatSchema = z.strictObject({
  added: z.int().nonnegative(),
  removed: z.int().nonnegative(),
});
export type DiffStat = z.infer<typeof DiffStatSchema>;

export const GitScopeSchema = z.enum(["branch", "uncommitted", "commit"]);
export type GitScope = z.infer<typeof GitScopeSchema>;
export const GitComparisonSchema = z.object({
  ready: z.boolean(),
  scope: GitScopeSchema,
  base: z.string(),
  head: z.string(),
  baseLabel: z.string(),
  branch: z.string(),
  revision: z.string(),
  capturedAt: z.string(),
  truncated: z.boolean(),
  files: z.array(
    z.object({
      path: z.string(),
      previousPath: z.string().nullable(),
      status: z.enum([
        "added",
        "modified",
        "deleted",
        "renamed",
        "copied",
        "untracked",
        "typechanged",
      ]),
      additions: z.number().int().nonnegative(),
      deletions: z.number().int().nonnegative(),
      binary: z.boolean(),
      truncated: z.boolean(),
      patch: z.string(),
    }),
  ),
});
export type GitComparison = z.infer<typeof GitComparisonSchema>;
