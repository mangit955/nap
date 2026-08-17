/**
 * Which Nap this invocation is, read from the checkout it is running out of.
 *
 * The impure half of the harness identity: `@nap/bench` defines what the record is and what a
 * comparison makes of it, and cannot see a git repository any more than it can see a filesystem
 * (docs/adr/0001). This asks git, here in the app.
 *
 * **A run that cannot be identified records nothing**, rather than a placeholder. `null` means
 * *unrecorded*, which is the honest answer for a copy of the source with no `.git` beside it,
 * and it is the same answer every report written before V2 gives. A stand-in — "unknown", a
 * zeroed sha — would be a fourth thing a reader has to learn is not an identity.
 */

import { execFileSync } from "node:child_process";
import type { HarnessRecord } from "@nap/bench/run-configuration";

/**
 * One git command, answering `null` when git could not.
 *
 * A port rather than a call, so the two facts below are assertable without a fixture repository
 * — the interesting cases are a modified tree and a directory git refuses to answer about, and
 * neither is something a test should have to build.
 */
export type GitReader = (args: readonly string[]) => string | null;

/** Reads a real repository, treating any failure as "git could not say". */
export function gitAt(cwd: string): GitReader {
  return (args) => {
    try {
      return execFileSync("git", [...args], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      // Not in a checkout, git not installed, a repository in a state it will not answer about:
      // all of them are the same thing to a report, which is that nobody can say what ran.
      return null;
    }
  };
}

/**
 * The harness identity, or null when the checkout could not be identified.
 *
 * `verification` is passed rather than detected: whether the loop ran is a fact about how this
 * process composed its runtime, and the only thing that knows it is the composition root.
 */
export function harnessIdentity(options: {
  git: GitReader;
  verification: boolean;
}): HarnessRecord | null {
  const commit = options.git(["rev-parse", "HEAD"])?.trim();
  if (commit === undefined || commit === "") return null;

  // Asked separately, and a failure here is *not* fatal to the identity: a sha nobody can prove
  // clean is still the sha, and the report says the tree was modified — which is the reading
  // that under-claims rather than over-claims.
  const status = options.git(["status", "--porcelain"]);

  return {
    commit,
    dirty: status === null || status.trim() !== "",
    verification: options.verification,
  };
}
