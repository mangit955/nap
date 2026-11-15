# Gotchas: Workspace, build and tooling

Learned the hard way; don't rediscover them. Read this before touching package layout, imports, `bun`, turbo, Biome, Next config.

- **A cold dev compile does not prove a long-lived Tailwind process can refresh.** The local computer launcher exposed corrupt CSS-variable candidate bytes after a globals.css hot reload under Turbopack. Correcting its working directory did not eliminate the failure. The launcher uses the supported webpack dev path, without changing normal web scripts or dependencies. See [actual failures, upstream references and bounded checks](research/computer-local-app/integration/ui-cleanup/README.md).

- **Packages resolve to TypeScript source**, via `"exports": { "./*": "./src/*.ts" }` in each `package.json`. Import as `@nap/shared/version`, not `@nap/shared`. There is no build step for tests or typecheck, and no root barrel to import from — which is what enforces the no-barrel-files rule.

- **Relative imports need an explicit `.ts` extension** (`allowImportingTsExtensions` is on in `tsconfig.base.json`). Safe because `tsc` never emits — Vite and Bun do the transpiling.

- **Adding a cross-package dependency requires re-running `bun install`** to create the workspace symlink, or the import resolves at typecheck but fails at runtime.

- **`bun run <script>` resolves against the nearest `package.json`, and a shell's cwd persists between commands.** A stray `cd` is enough for `bun run test` to quietly run a single package's scripts, or for `bun add` to install into the wrong workspace — both of which have happened. Run from the repo root unless you specifically mean not to.

- **Anything the root `vitest.config.ts` imports must be a *root* devDependency.** `@vitejs/plugin-react` installed into `apps/web` fails at config load with `ERR_MODULE_NOT_FOUND`, because the config resolves from the root.

- **A `PostToolUse` hook reformats each file after you write it.** So an `Edit` whose `old_string` came from text you wrote earlier in the turn can fail to match — Biome may have reflowed it. Re-read the file rather than guessing at the diff.

- **`next dev` writes `apps/web/AGENTS.md` and `apps/web/CLAUDE.md` itself**, and re-creates them if deleted. They are committed so the tree stays clean. The generated note is worth heeding: Next 16 differs from what most training data assumes, and `apps/web/node_modules/next/dist/docs/` is the version-accurate reference.

- **Turbo runs tasks in strict env mode**, so an exported variable does *not* reach a task unless it is listed in that task's `passThroughEnv` in `turbo.json`. `DATABASE_URL=… bun run dev` silently produced a "missing DATABASE_URL" boot failure until `dev` declared it. The normal path is a `.env` file, which Bun auto-loads from the app directory.

- **Bun installs and dispatches; Node executes.** `bun run` honours a binary's shebang, so Vitest and Next.js run under Node. Only `apps/api` and our own entrypoints use the Bun runtime. This is deliberate — see "Bun/Node split" in `docs/PLAN.md`.

- **The integration suite loads `apps/api/.env` itself**, via `test/integration-setup.ts`. Bun auto-loads that file for the API, but Vitest runs under Node, which does not — so without it every integration run would need the variables exported by hand.

- **`process.loadEnvFile` is a Node API that Bun does not implement.** It is fine in `test/integration-setup.ts` (Vitest → Node) and throws in anything run by `bun run`. Scripts under `bun run` parse the file themselves.

- **A test in `test/` can only import a workspace package if the *root* `package.json` depends on it.** Bun links `@nap/*` into the root `node_modules` for the packages something depends on, and nothing depended on `@nap/agent` or `@nap/context` — so `test/project-root.test.ts` failed to resolve them until they were added as root devDependencies. Same rule as `@vitejs/plugin-react`: resolution for repo-level files happens from the root. `test/architecture.ts` reads only `packages/*` and `apps/*` — their manifests and their `src` — so root devDependencies do not disturb it.

- **Hoisting makes an undeclared workspace import work anyway.** Every `@nap/*` package is linked into the root `node_modules`, so a package can import a sibling it never declared and have it resolve, typecheck and pass CI — and because the deployed image is one workspace-wide install from `COPY . .`, it ships. `checkSourceImports` in `test/architecture.ts` is what catches it: it reads the specifiers in each package's `src` and `scripts` rather than its manifest, which is where a layering violation is actually written.

- **Biome lints HTML, which makes it a participant in any corpus of deliberately bad pages.** `apps/napbench/fixtures/` holds nine hand-written applications the product judge has to be able to tell apart, and several are bad on purpose — inline `onchange` handlers, no stylesheet, decorative SVGs with no title. Biome 2.5 parses `.html` and reported 69 errors against them, all of them describing the fixture correctly. The directory is excluded in `biome.json` rather than the rules being relaxed: linting a specimen would make our lint configuration part of the corpus's design, and the benchmark would end up measuring adherence to it. The TypeScript beside them is inside every gate as usual.

- **`apps/web` imports workspace packages only because `next.config.ts` lists them in `transpilePackages`.** They resolve to raw TypeScript source (`"exports": { "./*": "./src/*.ts" }`, no build step), which Next otherwise treats as published JavaScript and fails to parse. `bun run build` is the only gate that catches a missing entry — the vitest projects resolve through Vite and do not care.
