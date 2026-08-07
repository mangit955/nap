/**
 * Builds and publishes the Nap project template to E2B.
 *
 * Run by hand — `bun run template:build` from `packages/sandbox` — never by a test. A
 * build takes minutes, costs money, and publishes a named artifact that every later
 * sandbox creation depends on, so it must not be a side effect of running the suite.
 *
 * The layer order matters: the dependency manifest is copied and installed *before* the
 * application sources, so editing `App.tsx` reuses the cached install layer instead of
 * repeating it.
 *
 * Base image choice is deliberate. E2B's own base is the only one guaranteed to carry
 * the `user` account (uid 1000) that sandboxes run as, and it already has git and curl —
 * but its Node is 20.9, which is below what current Vite supports. So Node and Bun are
 * both installed here, at build time, where they cost nothing at project-creation time.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultBuildLogger, Template } from "e2b";
import { NAP_TEMPLATE, TEMPLATE_WORKDIR } from "../src/template.ts";

const TEMPLATE_DIR = join(import.meta.dirname, "..", "template");

// Credentials live in apps/api/.env by convention. Bun only auto-loads a .env from the
// working directory, which for this script is packages/sandbox — and `process.loadEnvFile`
// is a Node API that Bun does not implement, so this parses the file rather than
// delegating. Anything already exported wins.
const ENV_FILE = join(import.meta.dirname, "..", "..", "..", "apps", "api", ".env");
if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const match = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/i.exec(line);
    if (match === null) continue;
    const [, key, rawValue] = match;
    if (key === undefined || rawValue === undefined || process.env[key] !== undefined) continue;
    process.env[key] = rawValue.trim().replace(/^["'](.*)["']$/, "$1");
  }
}

if (!process.env.E2B_API_KEY) {
  console.error(`E2B_API_KEY is not set. Add it to ${ENV_FILE}, or export it, then retry.`);
  process.exit(1);
}

/**
 * Node 24 from NodeSource; the base image's 20.9 is too old for Vite.
 *
 * The relinking is not optional. NodeSource installs into `/usr/bin`, but the base image
 * ships its own Node in `/usr/local/bin`, which comes *first* on PATH — so without this
 * the upgrade installs successfully and changes nothing, and `node --version` still says
 * 20.9. That failure is completely silent until Vite refuses to start.
 */
const INSTALL_NODE = [
  "curl -fsSL https://deb.nodesource.com/setup_24.x | bash -",
  "apt-get install -y nodejs",
  'for b in node npm npx; do [ -x "/usr/bin/$b" ] && ln -sf "/usr/bin/$b" "/usr/local/bin/$b"; done',
  "true",
].join(" && ");

/** BUN_INSTALL puts the binary on the default PATH rather than in a login shell's rc file. */
const INSTALL_BUN = "curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash";

/**
 * Identity is passed per-invocation rather than written to global git config, so that
 * the commit helpers added later cannot end up silently depending on config baked in
 * here — they have to set their own.
 */
const GIT_INIT = [
  "git init -b main",
  "git add -A",
  'git -c user.email=agent@nap.dev -c user.name=Nap commit -m "Initial commit"',
].join(" && ");

const template = Template({
  fileContextPath: TEMPLATE_DIR,
  // Local build noise must never reach the image; node_modules in particular would
  // defeat the point of installing inside it.
  fileIgnorePatterns: ["node_modules", "dist", ".git"],
})
  .fromBaseImage()
  .runCmd(INSTALL_NODE, { user: "root" })
  .runCmd(INSTALL_BUN, { user: "root" })
  .makeDir(TEMPLATE_WORKDIR, { user: "user" })
  .setWorkdir(TEMPLATE_WORKDIR)
  .setUser("user")
  // Manifest first: this layer is the expensive one and should survive source edits.
  .copy("package.json", TEMPLATE_WORKDIR, { user: "user" })
  .runCmd("bun install", { user: "user" })
  .copy(".", TEMPLATE_WORKDIR, { user: "user" })
  .runCmd(GIT_INIT, { user: "user" });

const startedAt = Date.now();
const info = await Template.build(template, NAP_TEMPLATE, {
  onBuildLogs: defaultBuildLogger(),
});

const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`\nBuilt ${NAP_TEMPLATE} in ${seconds}s`);
console.log(info);
