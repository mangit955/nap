/**
 * Enforces the dependency direction that docs/PLAN.md §0 declares:
 *
 *   runtime → {context, agent, sandbox, db} → shared
 *
 * The plan calls this "enforced"; this module is what makes that word true.
 * Kept pure — it takes parsed manifests and returns violations — so it can be
 * tested against synthetic inputs as well as the real workspace.
 */

export type Manifest = {
  name: string;
  dependencies: string[];
};

export type Violation = {
  from: string;
  to: string;
  reason: string;
};

/** Which internal packages each package is allowed to depend on. */
const ALLOWED: Record<string, readonly string[]> = {
  "@nap/shared": [],
  "@nap/db": ["@nap/shared"],
  "@nap/sandbox": ["@nap/shared"],
  "@nap/agent": ["@nap/shared"],
  "@nap/context": ["@nap/shared"],
  "@nap/runtime": ["@nap/context", "@nap/agent", "@nap/sandbox", "@nap/db", "@nap/shared"],
  // Apps compose everything; they are the top of the graph.
  "@nap/web": ["*"],
  "@nap/api": ["*"],
};

/**
 * Third-party packages that only one workspace package may depend on, because
 * the whole point of the abstraction is that nothing else knows about them.
 */
const EXCLUSIVE_EXTERNALS: Record<string, { owner: string; reason: string }> = {
  e2b: {
    owner: "@nap/sandbox",
    reason:
      "E2B belongs to @nap/sandbox. Depend on the SandboxManager interface from @nap/shared instead — see docs/PLAN.md §0.",
  },
};

export function checkDependencyDirection(manifests: Manifest[]): Violation[] {
  const violations: Violation[] = [];

  for (const { name, dependencies } of manifests) {
    const allowed = ALLOWED[name];

    if (allowed === undefined) {
      violations.push({
        from: name,
        to: "",
        reason: `unknown package "${name}" — add it to the ALLOWED table in test/architecture.ts so its dependencies are checked`,
      });
      continue;
    }

    for (const dep of dependencies) {
      const exclusive = EXCLUSIVE_EXTERNALS[dep];
      if (exclusive !== undefined && name !== exclusive.owner) {
        violations.push({ from: name, to: dep, reason: exclusive.reason });
        continue;
      }

      // Third-party dependencies are unconstrained.
      if (!dep.startsWith("@nap/")) continue;

      if (allowed.includes("*") || allowed.includes(dep)) continue;

      violations.push({
        from: name,
        to: dep,
        reason:
          allowed.length === 0
            ? `${name} is the base package and may only depend on third-party code, but depends on ${dep}`
            : `${name} may only depend on ${allowed.join(", ")} — but depends on ${dep}`,
      });
    }
  }

  return violations;
}
