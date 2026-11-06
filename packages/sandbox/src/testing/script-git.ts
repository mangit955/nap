/**
 * The git a project's sandbox is expected to answer with.
 *
 * Every test above this package that involves a turn ending has to script the same commands,
 * because committing is how a turn reports what it changed and snapshotting is how the work
 * outlives the sandbox. Six test files had written this out for themselves, in four slightly
 * different shapes — same regexes, different defaults — which is the kind of agreement that holds
 * right up until the commit sequence gains a step.
 *
 * The two knobs are the two things tests actually vary: whether the working tree had anything to
 * commit, and whether a bundle can be produced.
 */

import { NOTHING_TO_COMMIT } from "../git.ts";
import type { InMemorySandboxManager, ScriptedExecResponse } from "./in-memory-sandbox-manager.ts";

/** A plausible sha. Fixed, because tests assert on it and a random one reads as meaningful. */
export const FAKE_COMMIT_SHA = "9e107d9d372bb6826bd81d3542a419d6c2b0f5a1";

/** What `git bundle create` writes, as the base64 the exec fake hands back. */
export const FAKE_BUNDLE_B64 = Buffer.from("PACK-bundle-bytes").toString("base64");

/**
 * The one command `commitAll` sends — stage, check, commit and read the sha, in a single script.
 *
 * A fake that still answers the four commands it replaced answers none of this, so the fake throws
 * or falls to its `defaultExec`, whose empty output `commitAll` refuses rather than reads as a
 * clean tree. Script it with this, and answer with `committed` or `NOTHING_COMMITTED`.
 */
export const COMMIT_COMMAND = /git add --all && /;

/** The commit script's answer when it made a commit. */
export function committed(sha: string = FAKE_COMMIT_SHA): ScriptedExecResponse {
  return { exitCode: 0, stdout: `[main ${sha.slice(0, 7)}] Nap turn\n${sha}\n` };
}

/** The commit script's answer when the tree was already clean. */
export const NOTHING_COMMITTED: ScriptedExecResponse = {
  exitCode: 0,
  stdout: `${NOTHING_TO_COMMIT}\n`,
};

export function scriptGit(
  manager: InMemorySandboxManager,
  options: { dirty?: boolean; sha?: string; bundle?: string } = {},
): InMemorySandboxManager {
  const { dirty = true, sha = FAKE_COMMIT_SHA, bundle = FAKE_BUNDLE_B64 } = options;

  return manager
    .script(COMMIT_COMMAND, dirty ? committed(sha) : NOTHING_COMMITTED)
    .script(/git rev-parse HEAD/, { exitCode: 0, stdout: `${sha}\n` })
    .script(/git bundle create/, { exitCode: 0, stdout: bundle });
}
