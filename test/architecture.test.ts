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
        const parsed = JSON.parse(raw) as { name: string; dependencies?: Record<string, string> };
        return {
          name: parsed.name,
          dependencies: Object.keys(parsed.dependencies ?? {}),
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

  it("covers every workspace package", () => {
    // Guards against the check silently going quiet because a package was
    // renamed or added and the rule table never learned about it.
    const names = readWorkspaceManifests().map((m) => m.name);
    expect(names.toSorted()).toEqual([
      "@nap/agent",
      "@nap/api",
      "@nap/context",
      "@nap/db",
      "@nap/runtime",
      "@nap/sandbox",
      "@nap/shared",
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
