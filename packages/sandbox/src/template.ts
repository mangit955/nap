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
 *
 * The design system is part of that definition rather than an optional extra. `AGENTS.md`
 * is the brief, `src/index.css` carries the tokens every component reads, and the
 * primitives under `src/components/ui` are copied in rather than installed — so a project
 * missing one of them is missing something no `bun install` would put back.
 */
export const TEMPLATE_FILES = [
  ".gitignore",
  "AGENTS.md",
  "package.json",
  "index.html",
  "vite.config.ts",
  "tsconfig.json",
  "src/main.tsx",
  "src/App.tsx",
  "src/index.css",
  "src/lib/utils.ts",
  "src/components/ui/badge.tsx",
  "src/components/ui/button.tsx",
  "src/components/ui/card.tsx",
  "src/components/ui/checkbox.tsx",
  "src/components/ui/dialog.tsx",
  "src/components/ui/input.tsx",
  "src/components/ui/label.tsx",
  "src/components/ui/select.tsx",
  "src/components/ui/separator.tsx",
  "src/components/ui/tabs.tsx",
  "src/components/ui/textarea.tsx",
] as const;
