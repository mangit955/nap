/**
 * Enforces the dependency direction that docs/PLAN.md §0 declares:
 *
 *   runtime → {context, agent, sandbox, db, verify} → shared
 *
 * The plan calls this "enforced"; this module is what makes that word true.
 * Kept pure — it takes parsed manifests and file contents and returns violations —
 * so it can be tested against synthetic inputs as well as the real workspace.
 *
 * One table, read twice. `checkDependencyDirection` reads the manifests, which is where
 * the exclusive-externals rule has to live: a third-party package with one owner is a fact
 * about what gets installed. `checkSourceImports` reads the specifiers the source actually
 * imports, because a manifest is a declaration and the import is the edge — Bun hoists
 * workspace packages into one root `node_modules`, so an import of a package this one never
 * declared resolves and typechecks, and the production image is built by one workspace-wide
 * install over the whole repo, so it ships too.
 */

export type Manifest = {
  name: string;
  dependencies: string[];
  /**
   * Optional, and only the exclusive-externals rule reads it. The two rules want different
   * answers: a sibling package may sit here, so that a package's tests can use another's
   * published fakes (`@nap/agent` carries `@nap/sandbox` this way), while a third-party library
   * that is supposed to have exactly one owner may not, because the production image is built by
   * one workspace-wide install with no --production and therefore ships devDependencies too.
   */
  devDependencies?: string[];
};

export type Violation = {
  /** The package name for a manifest violation; the file path for an import one. */
  from: string;
  to: string;
  reason: string;
};

export type SourceFile = {
  /** Repo-relative, e.g. `packages/verify/src/preview.ts`. */
  path: string;
  contents: string;
};

/** One workspace package: what it says it depends on, and what its source actually imports. */
export type PackageSources = {
  manifest: Manifest;
  files: SourceFile[];
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
  // Running one check against a sandbox and saying what it produced: the preview probe, the
  // captured output of a failed command, and the passed/failed/absent answer. The runtime uses
  // it to verify a turn's claim. It was moved below the runtime so that the retired NapBench
  // could share it without the runtime importing the benchmark (docs/adr/0007), and it stays a
  // package of its own because it knows nothing about turns.
  "@nap/verify": ["@nap/shared"],
  // The pure half of the load harness: percentile maths, metric rollup, threshold verdicts, the
  // scripted user's ordering, and how slow the fakes pretend to be. It sits beside `shared`: it is
  // written against the ports there and knows nothing about Postgres, a socket or a server, which
  // is what lets the arithmetic a report is read through be tested rather than trusted. The
  // process that composes real infrastructure behind it is `apps/api/scripts/loadgen.ts`, which is
  // an app and may reach for anything.
  "@nap/loadgen": ["@nap/shared"],
  "@nap/runtime": [
    "@nap/context",
    "@nap/agent",
    "@nap/sandbox",
    "@nap/db",
    "@nap/storage",
    "@nap/capture",
    "@nap/verify",
    "@nap/shared",
  ],
  // Apps compose everything; they are the top of the graph.
  "@nap/web": ["*"],
  "@nap/api": ["*"],
  // A developer tool, never deployed: it drives a real Chrome against a local Nap to prove a UI
  // change. It is an app so that it can own Playwright (below) without anything that ships
  // owning it.
  "@nap/verify-nap": ["*"],
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
    owner: "@nap/verify-nap",
    reason:
      "Playwright belongs to apps/verify-nap, the developer tool that drives a real Chrome against a local Nap. Nothing that ships to production may depend on it — the deployed image is built from one workspace-wide install, so a test tool's browser driver would otherwise become the API's problem. A shipped package that needs a browser goes through the PageCapture interface (@nap/capture); a test that needs one speaks the DevTools protocol, as sidebar-drag.integration.test.ts does.",
  },
};

/**
 * Every form a specifier can arrive in: `import x from "y"`, `import "y"`, `export … from "y"`,
 * `await import("y")` and `require("y")`. Type-only imports are deliberately not distinguished —
 * `import type` erases at runtime but the compiler still had to read the other package, so it is
 * a layering edge, and it is the form a violation is likeliest to take.
 *
 * It matches text, not syntax, so a comment or string quoting `from "@nap/…"` counts as an import.
 * That is the cheap direction to be wrong in — a commented-out illegal import is still a decision
 * somebody should have to defend — but it is why a failure can name a line with no code on it.
 */
const SPECIFIER = /\b(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g;

/** `@nap/db/schema` → `@nap/db`. Every package exports `./*`, so specifiers are deep. */
function packageOf(specifier: string): string {
  const [scope, name] = specifier.split("/");
  return name === undefined ? specifier : `${scope}/${name}`;
}

/**
 * What a file is for, which decides how much of the rule table it answers to.
 *
 *   - `shipped` — everything under `src` that is not a test, including the published fakes in
 *     `src/testing`. Held to the layer table.
 *   - `test` — `.test.ts`, `.test.tsx`, `.test-d.ts`, and the `.db.`/`.integration.` infixes on
 *     top of them. Exempt from the layer table but not from the manifest.
 *   - `script` — a package's `scripts/`, which is real credentials and composition and never
 *     ships as a module. Same treatment as a test.
 */
function fileRole(path: string): "shipped" | "test" | "script" {
  if (/\.(?:test|test-d)\.tsx?$/.test(path)) return "test";
  return path.includes("/scripts/") ? "script" : "shipped";
}

/**
 * The one place the layer table is consulted, so the manifest rule and the import rule cannot
 * drift into disagreeing about what is permitted. Only the verb differs between them.
 */
function layerViolation(
  name: string,
  dep: string,
  allowed: readonly string[],
  verb: "depends on" | "imports",
): string | undefined {
  if (allowed.includes("*") || allowed.includes(dep)) return undefined;
  return allowed.length === 0
    ? `${name} is the base package and may only depend on third-party code, but ${verb} ${dep}`
    : `${name} may only depend on ${allowed.join(", ")} — but ${verb} ${dep}`;
}

/**
 * The same rule table, read against the imports rather than the manifests.
 *
 * The manifest check can only see edges somebody remembered to declare, and Bun hoists every
 * workspace package into one root `node_modules` — so an undeclared import resolves, typechecks
 * and ships, because the deployed image is built by a single workspace-wide install over the
 * whole repo. Two things are checked here:
 *
 *   - Shipped source may only import what ALLOWED lets the package depend on. Tests and scripts
 *     are exempt from *this* half: siblings arrive as devDependencies for their published fakes,
 *     and a test-only edge is not the layering the table is about.
 *   - Every file — shipped, test or script — may only import a package its manifest declares.
 *     That is the hoisting hole, and it is how a test importing @nap/sandbox with no
 *     devDependency on it shipped green.
 */
export function checkSourceImports(packages: PackageSources[]): Violation[] {
  const violations: Violation[] = [];

  for (const { manifest, files } of packages) {
    const allowed = ALLOWED[manifest.name];
    const declared = new Set([...manifest.dependencies, ...(manifest.devDependencies ?? [])]);

    for (const { path, contents } of files) {
      const imported = new Set(
        [...contents.matchAll(SPECIFIER)]
          .map((match) => packageOf(match[1] ?? ""))
          .filter((name) => name.startsWith("@nap/") && name !== manifest.name),
      );

      for (const dep of imported) {
        if (allowed === undefined) {
          violations.push({
            from: path,
            to: dep,
            reason: `unknown package "${manifest.name}" — add it to the ALLOWED table in test/architecture.ts so its imports are checked`,
          });
          continue;
        }

        if (!declared.has(dep)) {
          violations.push({
            from: path,
            to: dep,
            reason: `${path} imports ${dep}, but ${manifest.name} does not declare it in package.json. It resolves only because Bun hoists workspace packages — declare the dependency, or drop the import`,
          });
          continue;
        }

        const layering = layerViolation(manifest.name, dep, allowed, "imports");

        // Tests and scripts answer to the manifest, not the table.
        if (fileRole(path) !== "shipped") continue;

        if (layering !== undefined) {
          violations.push({ from: path, to: dep, reason: `${path}: ${layering}` });
          continue;
        }

        if (!manifest.dependencies.includes(dep)) {
          violations.push({
            from: path,
            to: dep,
            reason: `${path} imports ${dep}, but ${manifest.name} declares it only as a devDependency. Shipped source needs a real dependency — the manifest rule reads \`dependencies\` alone, so moving an edge into devDependencies is how an import gets past both checks`,
          });
        }
      }
    }
  }

  return violations;
}

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

      const reason = layerViolation(name, dep, allowed, "depends on");
      if (reason === undefined) continue;

      violations.push({ from: name, to: dep, reason });
    }
  }

  return violations;
}
