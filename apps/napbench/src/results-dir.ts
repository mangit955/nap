import { isAbsolute, join, resolve } from "node:path";
import { RESULTS_DIR } from "@nap/bench/results-dir";

/**
 * The variable that moves a run's artefacts somewhere other than the shared results directory.
 *
 * It exists for one caller: an external harness gives every trial its own job directory and
 * expects that trial's files to be in it, rather than in a folder shared with every run this
 * checkout has ever performed. Naming it here rather than reading `process.env` in the script
 * keeps the rule — absolute wins, relative resolves against the repository — somewhere a test
 * can drive it.
 */
export const RESULTS_DIR_ENV = "NAPBENCH_RESULTS_DIR";

/**
 * Resolves the directory a run writes into, given the repository root.
 *
 * The split is the one this app exists for: `@nap/bench` says what the directory is
 * called and nothing else, and everything that touches a real filesystem lives here.
 *
 * An override is honoured when the environment carries one, because a run performed under a
 * harness has to put its report where that harness will look. A relative override is resolved
 * against the repository root rather than the working directory, so it means the same thing
 * whichever directory the process was started from.
 */
export function resolveResultsDir(repoRoot: string, env: Record<string, string | undefined> = {}) {
  const override = env[RESULTS_DIR_ENV];
  if (override !== undefined && override.length > 0) {
    return isAbsolute(override) ? resolve(override) : resolve(repoRoot, override);
  }

  return join(repoRoot, RESULTS_DIR);
}
