/**
 * The git a project's sandbox is expected to answer with.
 *
 * Every test above this package that involves a turn ending has to script the same four commands,
 * because committing is how a turn reports what it changed and snapshotting is how the work
 * outlives the sandbox. Six test files had written this out for themselves, in four slightly
 * different shapes — same regexes, different defaults — which is the kind of agreement that holds
 * right up until the commit sequence gains a step.
 *
 * The two knobs are the two things tests actually vary: whether the working tree had anything to
 * commit, and whether a bundle can be produced.
 */

import type { InMemorySandboxManager } from "./in-memory-sandbox-manager.ts";

/** A plausible sha. Fixed, because tests assert on it and a random one reads as meaningful. */
export const FAKE_COMMIT_SHA = "9e107d9d372bb6826bd81d3542a419d6c2b0f5a1";

/** What `git bundle create` writes, as the base64 the exec fake hands back. */
export const FAKE_BUNDLE_B64 = Buffer.from("PACK-bundle-bytes").toString("base64");

export function scriptGit(
  manager: InMemorySandboxManager,
  options: { dirty?: boolean; sha?: string; bundle?: string } = {},
): InMemorySandboxManager {
  const { dirty = true, sha = FAKE_COMMIT_SHA, bundle = FAKE_BUNDLE_B64 } = options;

  return (
    manager
      .script(/git add -A/, { exitCode: 0 })
      // Non-zero means the index differs from HEAD, which is what makes a commit happen.
      .script(/git diff --cached --quiet/, { exitCode: dirty ? 1 : 0 })
      .script(/git .*commit -m/, { exitCode: 0 })
      .script(/git rev-parse HEAD/, { exitCode: 0, stdout: `${sha}\n` })
      .script(/git bundle create/, { exitCode: 0, stdout: bundle })
  );
}
