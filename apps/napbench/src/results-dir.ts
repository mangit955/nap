import { join } from "node:path";
import { RESULTS_DIR } from "@nap/bench/results-dir";

/**
 * Resolves the directory a run writes into, given the repository root.
 *
 * The split is the one this app exists for: `@nap/bench` says what the directory is
 * called and nothing else, and everything that touches a real filesystem lives here.
 */
export function resolveResultsDir(repoRoot: string): string {
  return join(repoRoot, RESULTS_DIR);
}
