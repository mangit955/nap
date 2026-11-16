import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The paid suite, added to the projects below only on request.
const integration = {
  test: {
    name: "integration",
    include: [
      "{packages,apps}/*/src/**/*.integration.test.ts",
      "{packages,apps}/*/scripts/**/*.integration.test.ts",
    ],
    // Real credentials live in apps/api/.env. Bun loads that for the API; Vitest
    // runs under Node, which does not — so the suite loads it explicitly.
    setupFiles: ["./test/integration-setup.ts"],
    // Real sandboxes and real models are slow; the default 5s timeout would fail
    // on cold start alone.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
};

// Suites split by filename rather than directory, so a package can hold several
// kinds side by side — the SandboxManager conformance suite is run by the fake
// (unit) and by the E2B adapter (integration) from the same folder.
// See docs/PLAN.md §3.
//
// Each project exists because it needs a *different environment*, not for tidiness:
// node, tsc, jsdom, and a Postgres container respectively. A test placed in the
// wrong one does not fail — it is silently never collected.
// A commit hook runs the suite with git's own variables exported — `GIT_DIR` and `GIT_INDEX_FILE`
// among them — and any git a test then starts acts on *this* repository, whatever its cwd. A
// fixture's `git init` and `git commit` have committed onto the branch being committed and set
// `core.bare` on the shared repository that way. Removing them here, before any worker starts,
// covers every test; one that needs a variable sets it itself.
for (const name of Object.keys(process.env)) {
  if (name.startsWith("GIT_")) delete process.env[name];
}

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          // test/ holds repo-wide tests that belong to no single package —
          // currently the dependency-direction check in test/architecture.ts.
          // `scripts/` as well as `src/`: the harnesses there are real code with real
          // logic — the load composition's shared sandbox store is what a whole cluster
          // run rests on — and a test written beside one is otherwise never collected.
          // Every project below globs it too, `types` through `tsconfig.test-d.json` as
          // well, because a suite that covers `scripts` in one project and not the next
          // is the silent-miss trap in a new place.
          include: [
            "{packages,apps}/*/src/**/*.test.ts",
            "{packages,apps}/*/scripts/**/*.test.ts",
            "test/**/*.test.ts",
          ],
          // These still match `*.test.ts` — the infix does not stop the glob — so without
          // excluding them here they would be collected twice, and the `db` ones would run a
          // second time with no database behind them.
          exclude: ["**/*.integration.test.ts", "**/*.db.test.ts", "**/*.computer.test.ts"],
        },
      },
      {
        // The computer-use suites that start real processes — the desktop start script, the local
        // Docker sandbox's transport, the app-test command — and take tens of seconds each. Same
        // node environment as `unit`; split out only so `test:fast` stays fast. `bun run test` and
        // CI still run them. The `.computer` infix still matches `*.test.ts`, hence the exclude
        // above.
        test: {
          name: "computer",
          include: [
            "{packages,apps}/*/src/**/*.computer.test.ts",
            "{packages,apps}/*/scripts/**/*.computer.test.ts",
          ],
        },
      },
      {
        // Type-level tests. These are compile-time only: `expectTypeOf` has no
        // runtime effect, so without this project a `*.test-d.ts` file is never
        // collected and a wrong assertion in it passes silently.
        test: {
          name: "types",
          typecheck: {
            enabled: true,
            include: [
              "{packages,apps}/*/src/**/*.test-d.ts",
              "{packages,apps}/*/scripts/**/*.test-d.ts",
            ],
            tsconfig: "./tsconfig.test-d.json",
          },
          // The type tests *are* the suite here; there are no runtime tests to run.
          include: [],
        },
      },
      {
        // Tests against a real Postgres in a container. Free and deterministic, so
        // docs/PLAN.md §3 puts them in the default suite — but they need Docker and cost
        // seconds rather than milliseconds, which is why they are separable: run
        // `bun run test:fast` for the unit + type loop when Docker is not around.
        test: {
          name: "db",
          include: [
            "{packages,apps}/*/src/**/*.db.test.ts",
            "{packages,apps}/*/scripts/**/*.db.test.ts",
          ],
          globalSetup: ["./packages/db/src/testing/global-setup.ts"],
          // One shared container; parallel files would contend over the same tables.
          fileParallelism: false,
        },
      },
      {
        // React component tests. `.tsx` is what routes a test here, and it needs both a
        // JSX transform and a DOM — neither of which the `unit` project has.
        plugins: [react()],
        test: {
          name: "web",
          include: ["{packages,apps}/*/src/**/*.test.tsx"],
          environment: "jsdom",
          setupFiles: ["./apps/web/src/testing/setup.ts"],
          // Node 25 turned on its own Web Storage, whose `localStorage` is undefined without a
          // backing file and shadows jsdom's — every test touching it then throws on `.clear()`.
          execArgv: ["--no-experimental-webstorage"],
        },
      },
      // The integration suite spends money, so it exists only when `bun run test:integration` sets
      // NAP_INTEGRATION. Filtering cannot keep it out: positional arguments are substring filters
      // across every project, and `--project` matches case-insensitively and takes `!` negation,
      // so `vitest run .test.ts`, `--project INTEGRATION` and `--project '!unit'` all reached it.
      // test/integration-gate.test.ts holds this.
      // biome-ignore lint/suspicious/noUndeclaredEnvVars: Vitest runs directly, outside Turbo.
      ...(process.env.NAP_INTEGRATION === "1" ? [integration] : []),
    ],
  },
});
