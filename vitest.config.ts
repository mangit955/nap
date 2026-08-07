import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Suites split by filename rather than directory, so a package can hold several
// kinds side by side — the SandboxManager conformance suite is run by the fake
// (unit) and by the E2B adapter (integration) from the same folder.
// See docs/PLAN.md §3.
//
// Each project exists because it needs a *different environment*, not for tidiness:
// node, tsc, jsdom, and a Postgres container respectively. A test placed in the
// wrong one does not fail — it is silently never collected.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          // test/ holds repo-wide tests that belong to no single package —
          // currently the dependency-direction check in test/architecture.ts.
          include: ["{packages,apps}/*/src/**/*.test.ts", "test/**/*.test.ts"],
          // Both of these still match `*.test.ts` — the infix does not stop the glob —
          // so without excluding them here they would be collected twice, and the `db`
          // ones would run a second time with no database behind them.
          exclude: ["**/*.integration.test.ts", "**/*.db.test.ts"],
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
            include: ["{packages,apps}/*/src/**/*.test-d.ts"],
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
          include: ["{packages,apps}/*/src/**/*.db.test.ts"],
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
        },
      },
      {
        test: {
          name: "integration",
          include: ["{packages,apps}/*/src/**/*.integration.test.ts"],
          // Real credentials live in apps/api/.env. Bun loads that for the API; Vitest
          // runs under Node, which does not — so the suite loads it explicitly.
          setupFiles: ["./test/integration-setup.ts"],
          // Real sandboxes and real models are slow; the default 5s timeout would fail
          // on cold start alone.
          testTimeout: 120_000,
          hookTimeout: 120_000,
        },
      },
    ],
  },
});
