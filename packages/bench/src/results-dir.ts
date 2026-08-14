/**
 * Where a benchmark run writes its report, its trajectory and its screenshots —
 * a single path segment, relative to the repository root.
 *
 * It is named in the pure core rather than in the app because two other things have to
 * agree with it: `.gitignore`, so that running the benchmark never dirties the tree, and
 * whatever later reads a report back to compare two runs. Resolving it against a root
 * directory is the app's job; this package touches no filesystem.
 */
export const RESULTS_DIR = "napbench-results";
