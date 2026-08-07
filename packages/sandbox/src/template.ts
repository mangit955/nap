/**
 * Identity of the custom E2B template every Nap project starts from.
 *
 * The template exists so that project creation does not have to run an install. Its
 * `node_modules` is baked into the image, which turns "user describes an app" →
 * "preview appears" from tens of seconds into a sandbox start. Building it is a manual
 * step (`bun run template:build` in this package), never something a test triggers.
 *
 * These constants are the contract between the build script, the code that creates
 * sandboxes, and the tests that check them — so none of the three can drift.
 */

/** Passed as the template argument when creating a sandbox that should hold a project. */
export const NAP_TEMPLATE = "nap-vite-react";

/**
 * Where the starter app lives, and the working directory commands run in.
 *
 * A subdirectory rather than `/home/user` itself: the project is a git repository, and
 * rooting it at the home directory makes `git add -A` sweep in `.profile`, shell history
 * and Bun's global install cache. The project must contain only the project.
 */
export const TEMPLATE_WORKDIR = "/home/user/app";

/** The port the starter app's dev server listens on. */
export const TEMPLATE_DEV_PORT = 5173;

/**
 * Files a freshly created project must contain.
 *
 * Kept here rather than in a test so the build script and the assertions cannot
 * disagree about what a project *is*, and so restoring a project later has something
 * to check itself against.
 */
export const TEMPLATE_FILES = [
  ".gitignore",
  "package.json",
  "index.html",
  "vite.config.ts",
  "tsconfig.json",
  "src/main.tsx",
  "src/App.tsx",
  "src/index.css",
] as const;
