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
  /**
   * Optional, and only the exclusive-externals rule reads it. The two rules want different
   * answers: a sibling package may sit here (docs/adr/0001 — @nap/bench carries them for
   * their published fakes), while a third-party library that is supposed to have exactly
   * one owner may not, because the production image is built by one workspace-wide install
   * with no --production and therefore ships devDependencies too.
   */
  devDependencies?: string[];
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
  // Object storage sits beside the sandbox and the database as infrastructure: it holds a
  // project's bytes while nothing is running, and knows nothing about turns or projects.
  "@nap/storage": ["@nap/shared"],
  // A browser, behind the PageCapture port. Beside storage and the sandbox for the same reason:
  // it photographs an address it is handed and knows nothing about projects or turns.
  "@nap/capture": ["@nap/shared"],
  // The pure half of NapBench: task specifications, scoring, gates, metric derivation,
  // report serialisation. None of it may reach for a sandbox, a model or a browser — those
  // arrive through ports, which is what keeps the part that has to be trustworthy testable
  // with no network. Its sibling packages appear under devDependencies for their published
  // fakes, which this check deliberately does not read. See docs/adr/0001.
  "@nap/bench": ["@nap/shared"],
  "@nap/runtime": [
    "@nap/context",
    "@nap/agent",
    "@nap/sandbox",
    "@nap/db",
    "@nap/storage",
    "@nap/capture",
    "@nap/shared",
  ],
  // Apps compose everything; they are the top of the graph.
  "@nap/web": ["*"],
  "@nap/api": ["*"],
  "@nap/napbench": ["*"],
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
  "@anthropic-ai/sdk": {
    owner: "@nap/agent",
    reason:
      "The Anthropic SDK belongs to @nap/agent. Depend on the LLMProvider interface from @nap/shared instead — see docs/PLAN.md §0. The interface is not a cross-vendor swap, but model id, effort, retries and refusal handling still belong in one place rather than at every call site.",
  },
  "@aws-sdk/client-s3": {
    owner: "@nap/storage",
    reason:
      "The S3 client belongs to @nap/storage, which is the only place that knows a project's bytes live in R2. Depend on the ObjectStore interface from @nap/shared instead — everything above it is written against three methods and must keep working when the bucket is a map in a test.",
  },
  "puppeteer-core": {
    owner: "@nap/capture",
    reason:
      "The browser belongs to @nap/capture, which is the only place that knows a thumbnail is made by rendering a page. Depend on the PageCapture interface from @nap/shared instead — everything above it is written against one method and must keep working when the browser is a fake handing back four bytes.",
  },
  "playwright-core": {
    owner: "@nap/napbench",
    reason:
      "Playwright belongs to apps/napbench, which drives a browser against a generated app to judge it. Nothing that ships to production may depend on it — the deployed image is built from one workspace-wide install, so an evaluation tool's browser driver would otherwise become the API's problem. Depend on the BrowserSession interface from @nap/bench instead. See docs/adr/0001.",
  },
  "axe-core": {
    owner: "@nap/napbench",
    reason:
      "The accessibility scanner belongs to apps/napbench for the same reason Playwright does: it is an evaluation tool, it runs inside a browser nothing that ships has, and the deployed image is built from one workspace-wide install. Depend on BrowserSession.scanAccessibility from @nap/bench instead — what counts as a violation is axe's answer, and nothing above the port needs to know whose. See docs/adr/0001.",
  },
  "@anthropic-ai/bedrock-sdk": {
    owner: "@nap/agent",
    reason:
      "Reaching the models through Bedrock rather than Anthropic directly is a transport detail, and it belongs to @nap/agent for the same reason the direct SDK does. Which platform serves a request must not be visible above the LLMProvider interface — the whole point is that the agent loop and the event contract cannot tell the difference.",
  },
};

export function checkDependencyDirection(manifests: Manifest[]): Violation[] {
  const violations: Violation[] = [];

  for (const { name, dependencies, devDependencies = [] } of manifests) {
    const allowed = ALLOWED[name];

    for (const dep of devDependencies) {
      const exclusive = EXCLUSIVE_EXTERNALS[dep];
      if (exclusive !== undefined && name !== exclusive.owner) {
        violations.push({ from: name, to: dep, reason: exclusive.reason });
      }
    }

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
