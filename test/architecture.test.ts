import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkDependencyDirection, type Manifest } from "./architecture.ts";

const repoRoot = join(import.meta.dirname, "..");

function readWorkspaceManifests(): Manifest[] {
  return ["packages", "apps"].flatMap((group) =>
    readdirSync(join(repoRoot, group), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const raw = readFileSync(join(repoRoot, group, entry.name, "package.json"), "utf8");
        const parsed = JSON.parse(raw) as {
          name: string;
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        return {
          name: parsed.name,
          dependencies: Object.keys(parsed.dependencies ?? {}),
          devDependencies: Object.keys(parsed.devDependencies ?? {}),
        };
      }),
  );
}

describe("dependency direction", () => {
  // docs/PLAN.md §0 calls this direction "enforced". This test is what makes
  // that true: runtime → {context, agent, sandbox, db} → shared.
  it("holds across the real workspace", () => {
    expect(checkDependencyDirection(readWorkspaceManifests())).toEqual([]);
  });

  it("keeps @nap/bench's internal runtime dependencies to @nap/shared alone", () => {
    // docs/adr/0001 permits @nap/bench to carry sibling packages as devDependencies, for
    // their published in-memory fakes — and the checker above reads `dependencies` only,
    // so that arrangement passes partly by not being looked at. This asserts the half that
    // matters directly: what a consumer of the pure core pulls in at runtime.
    //
    // Third-party dependencies are not the subject. The pure core validates every task and
    // report it parses, so it depends on zod exactly as @nap/shared does; what would break
    // the ADR is a *workspace* package other than shared.
    const bench = readWorkspaceManifests().find((m) => m.name === "@nap/bench");
    expect(bench?.dependencies.filter((dep) => dep.startsWith("@nap/"))).toEqual(["@nap/shared"]);
  });

  it("covers every workspace package", () => {
    // Guards against the check silently going quiet because a package was
    // renamed or added and the rule table never learned about it.
    const names = readWorkspaceManifests().map((m) => m.name);
    expect(names.toSorted()).toEqual([
      "@nap/agent",
      "@nap/api",
      "@nap/bench",
      "@nap/capture",
      "@nap/context",
      "@nap/db",
      "@nap/napbench",
      "@nap/runtime",
      "@nap/sandbox",
      "@nap/shared",
      "@nap/storage",
      "@nap/web",
    ]);
  });
});

describe("dependency direction — the checker actually catches violations", () => {
  // A checker that has never been seen to fail is not known to work. These
  // cases are the reason this file is worth having.
  it("rejects shared depending on anything internal", () => {
    const violations = checkDependencyDirection([
      { name: "@nap/shared", dependencies: ["@nap/runtime"] },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.from).toBe("@nap/shared");
    expect(violations[0]?.to).toBe("@nap/runtime");
  });

  it("rejects a leaf package depending on a sibling leaf", () => {
    const violations = checkDependencyDirection([
      { name: "@nap/agent", dependencies: ["@nap/db"] },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain("may only depend on");
  });

  it("rejects agent importing the E2B SDK instead of the SandboxManager interface", () => {
    // PLAN.md §0: "agent imports the SandboxManager interface, never the E2B
    // adapter." E2B belongs to @nap/sandbox alone.
    const violations = checkDependencyDirection([{ name: "@nap/agent", dependencies: ["e2b"] }]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain("SandboxManager");
  });

  it("allows sandbox to depend on the E2B SDK", () => {
    expect(checkDependencyDirection([{ name: "@nap/sandbox", dependencies: ["e2b"] }])).toEqual([]);
  });

  it("allows runtime to depend on every inner package", () => {
    const violations = checkDependencyDirection([
      {
        name: "@nap/runtime",
        dependencies: ["@nap/context", "@nap/agent", "@nap/sandbox", "@nap/db", "@nap/shared"],
      },
    ]);
    expect(violations).toEqual([]);
  });

  it("rejects Playwright anywhere but the benchmark app", () => {
    // docs/adr/0001: the deployed image is one workspace-wide install, so a browser driver
    // added to any package is a browser driver the production API carries.
    const violations = checkDependencyDirection([
      { name: "@nap/capture", dependencies: ["playwright-core"] },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain("BrowserSession");
  });

  it("rejects an exclusive external hidden in devDependencies", () => {
    // The image is built by one workspace-wide `bun install` with no --production, so a
    // devDependency ships too. Reading `dependencies` alone would have let the browser
    // driver into production through the back door — which is the exact thing
    // docs/adr/0001 justifies the rule by.
    const violations = checkDependencyDirection([
      { name: "@nap/capture", dependencies: [], devDependencies: ["playwright-core"] },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain("BrowserSession");
  });

  it("allows a sibling package in devDependencies", () => {
    // docs/adr/0001: @nap/bench carries siblings as devDependencies for their published
    // fakes, which is what makes the runner unit-testable. Only the *externals* rule
    // widens to devDependencies; the direction rule stays on runtime dependencies.
    const violations = checkDependencyDirection([
      { name: "@nap/bench", dependencies: ["@nap/shared"], devDependencies: ["@nap/sandbox"] },
    ]);
    expect(violations).toEqual([]);
  });

  it("allows the benchmark app to depend on Playwright", () => {
    expect(
      checkDependencyDirection([{ name: "@nap/napbench", dependencies: ["playwright-core"] }]),
    ).toEqual([]);
  });

  it("rejects the benchmark core reaching past @nap/shared", () => {
    const violations = checkDependencyDirection([
      { name: "@nap/bench", dependencies: ["@nap/runtime"] },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain("may only depend on");
  });

  it("allows apps to depend on any package", () => {
    const violations = checkDependencyDirection([
      { name: "@nap/api", dependencies: ["@nap/runtime", "@nap/shared"] },
    ]);
    expect(violations).toEqual([]);
  });

  it("ignores third-party dependencies", () => {
    expect(
      checkDependencyDirection([{ name: "@nap/context", dependencies: ["zod", "@nap/shared"] }]),
    ).toEqual([]);
  });

  it("reports every violation, not just the first", () => {
    const violations = checkDependencyDirection([
      { name: "@nap/shared", dependencies: ["@nap/db"] },
      { name: "@nap/agent", dependencies: ["@nap/runtime"] },
    ]);
    expect(violations).toHaveLength(2);
  });

  it("fails loudly on an unknown package rather than passing it", () => {
    // Silence on an unrecognised name is how this check would rot.
    const violations = checkDependencyDirection([
      { name: "@nap/mystery", dependencies: ["@nap/runtime"] },
    ]);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.reason).toContain("unknown");
  });
});
