import { defineConfig } from "vitest/config";

// Two suites, split by filename rather than directory, so a package can hold
// both kinds side by side — M1-1's SandboxManager conformance suite is run by
// the fake (unit) and by the E2B adapter (integration) from the same folder.
// See docs/PLAN.md §3.
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["{packages,apps}/*/src/**/*.test.ts"],
          exclude: ["**/*.integration.test.ts"],
        },
      },
      {
        test: {
          name: "integration",
          include: ["{packages,apps}/*/src/**/*.integration.test.ts"],
        },
      },
    ],
  },
});
