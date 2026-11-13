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

import { BUNDLE_PATH, NOTHING_TO_COMMIT } from "../git.ts";
import type { InMemorySandboxManager, ScriptedExecResponse } from "./in-memory-sandbox-manager.ts";

/** A plausible sha. Fixed, because tests assert on it and a random one reads as meaningful. */
export const FAKE_COMMIT_SHA = "9e107d9d372bb6826bd81d3542a419d6c2b0f5a1";

/** What `git bundle create` writes. Not a real bundle: nothing in a fake reads inside one. */
export const FAKE_BUNDLE = new TextEncoder().encode("PACK-bundle-bytes");

/** Matches the one command `bundle` sends, which writes the bundle and prints which ref HEAD is. */
export const BUNDLE_COMMAND = /git bundle create/;

/**
 * That command's answer: HEAD's ref on stdout, and the bundle left where `bundle` reads it from.
 * A fake answering with only stdout leaves nothing to read, and the snapshot fails.
 */
export function bundled(
  head = "refs/heads/main",
  bytes: Uint8Array = FAKE_BUNDLE,
): ScriptedExecResponse {
  return { exitCode: 0, stdout: `${head}\n`, writes: { [BUNDLE_PATH]: bytes } };
}

/**
 * The one command `commitAll` sends — stage, check, commit and read the sha, in a single script.
 *
 * A fake that still answers the four commands it replaced answers none of this, so the fake throws
 * or falls to its `defaultExec`, whose empty output `commitAll` refuses rather than reads as a
 * clean tree. Script it with this, and answer with `committed` or `NOTHING_COMMITTED`.
 */
export const COMMIT_COMMAND = /git add --all && /;

/** The line counts the fake's commit reports, unless a test asks for others. */
export const FAKE_COMMIT_DIFF = { added: 3, removed: 1 };

/** The commit script's answer when it made a commit: git's summary line, then the sha. */
export function committed(
  sha: string = FAKE_COMMIT_SHA,
  diff: { added: number; removed: number } = FAKE_COMMIT_DIFF,
): ScriptedExecResponse {
  return {
    exitCode: 0,
    stdout:
      `[main ${sha.slice(0, 7)}] Nap turn\n` +
      ` 1 file changed, ${diff.added} insertions(+), ${diff.removed} deletions(-)\n${sha}\n`,
  };
}

/** The commit script's answer when the tree was already clean. */
export const NOTHING_COMMITTED: ScriptedExecResponse = {
  exitCode: 0,
  stdout: `${NOTHING_TO_COMMIT}\n`,
};

export function scriptGit(
  manager: InMemorySandboxManager,
  options: { dirty?: boolean; sha?: string; bundle?: Uint8Array } = {},
): InMemorySandboxManager {
  const { dirty = true, sha = FAKE_COMMIT_SHA, bundle = FAKE_BUNDLE } = options;

  return manager
    .script(COMMIT_COMMAND, dirty ? committed(sha) : NOTHING_COMMITTED)
    .script(/git rev-parse HEAD/, { exitCode: 0, stdout: `${sha}\n` })
    .script(BUNDLE_COMMAND, bundled("refs/heads/main", bundle));
}

/** Matches the one command `restoreBundle` sends once the bundle is uploaded. */
export const RESTORE_COMMAND = /git bundle verify/;

/**
 * That command's answer when it was given a probe: what the probe printed on the tree being
 * replaced, then on the restored one. Answering with stdout alone reports nothing either way, which
 * a caller deciding something from the probe must treat as "cannot tell".
 */
export function restored(before: string, after: string = before): ScriptedExecResponse {
  return { exitCode: 0, stdout: `${before}\n${after}\n` };
}
