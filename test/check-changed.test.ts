import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { DESKTOP_SOURCES } from "../packages/sandbox/src/desktop-template.ts";
import {
  type ChangedFile,
  type Plan,
  planChecks,
  readInputs,
  TREE_READERS,
} from "../scripts/check-changed.ts";

const workspaces = [
  { name: "@nap/shared", dir: "packages/shared", dependsOn: [] },
  { name: "@nap/capture", dir: "packages/capture", dependsOn: ["@nap/shared"] },
  { name: "@nap/bench", dir: "packages/bench", dependsOn: ["@nap/capture"] },
  { name: "@nap/web", dir: "apps/web", dependsOn: ["@nap/shared"] },
  { name: "@nap/sandbox", dir: "packages/sandbox", dependsOn: ["@nap/shared"] },
];
// Runs apps/napbench's script, which imports @nap/bench, as a separate process.
const runner = "apps/napbench/scripts/napbench-app-test.test.ts";
const processRunners = { [runner]: ["@nap/bench"] };
const repoTests = ["test/architecture.test.ts", "test/docs.test.ts"];
const webTests = ["apps/web/src/app/font-placement.test.ts", "apps/web/src/brand/nap-mark.test.ts"];
const tests = [
  ...repoTests,
  ...webTests,
  "apps/web/src/dashboard/session-list.test.tsx",
  "apps/web/src/dashboard/sidebar-drag.integration.test.ts",
  "packages/capture/src/capture.test.ts",
  "packages/sandbox/src/desktop-start.computer.test.ts",
  "apps/api/scripts/local-sandbox.computer.test.ts",
];

// Real names, from `git grep` and vitest.config.ts on the day these were written.
const testsNaming = {
  "start-desktop.sh": ["packages/sandbox/src/desktop-start.computer.test.ts"],
  ".gitignore": ["packages/bench/src/results-dir.test.ts"],
  "0022_project_name_source.sql": ["packages/db/src/schema.db.test.ts"],
  "package.json": ["packages/sandbox/src/git-local.test.ts"],
  "tsconfig.json": ["test/project-root.test.ts", "apps/api/src/compose.test.ts"],
  "notes.md": ["packages/agent/src/screenshot-caching.integration.test.ts"],
};
const setupFiles = {
  "apps/web/src/testing/setup.ts": "web",
  "packages/db/src/testing/global-setup.ts": "db",
  "test/integration-setup.ts": "integration",
};

function plan(paths: readonly (string | ChangedFile)[], docker = true): Plan {
  const files = paths.map((path) => (typeof path === "string" ? { path, present: true } : path));
  return planChecks({
    files,
    workspaces,
    docker,
    tests,
    testsNaming,
    setupFiles,
    processRunners,
  });
}
const related = (result: Plan) => step(result, "tests")?.commands[0] ?? [];
const step = (result: Plan, name: string) => result.steps.find((s) => s.name === name);
const names = (result: Plan) => result.steps.map((s) => s.name);

describe("planChecks", () => {
  it("runs nothing when nothing changed", () => {
    expect(plan([])).toEqual({ steps: [], notes: [] });
  });

  it("typechecks the changed package and its dependents, then the root program", () => {
    expect(step(plan(["packages/capture/src/a.ts"]), "typecheck")?.commands).toEqual([
      ["bunx", "turbo", "run", "typecheck", "--filter=...@nap/capture"],
      ["bunx", "tsc", "--noEmit"],
    ]);
  });

  it("does not match a package by a shared name prefix", () => {
    const filters = step(plan(["packages/shared-extra/x.ts"]), "typecheck");
    expect(filters).toBeUndefined();
  });

  it("typechecks only the root program for a change under test/ or scripts/", () => {
    expect(step(plan(["scripts/x.ts"]), "typecheck")?.commands).toEqual([
      ["bunx", "tsc", "--noEmit"],
    ]);
  });

  it("skips typecheck when no TypeScript program can see the change", () => {
    expect(names(plan(["docs/commands.md"]))).toEqual(["biome", "tests"]);
  });

  it("treats a root package.json edit as a script edit, not a repo-wide change", () => {
    const result = plan(["package.json"]);
    expect(names(result)).toEqual(["biome", "tests"]);
    expect(step(result, "tests")?.commands[0]).toContain("related");
  });

  it("widens typecheck and tests to everything for a repo-wide config change", () => {
    const result = plan(["bun.lock"]);
    expect(step(result, "typecheck")?.commands[0]).toEqual([
      "bunx",
      "turbo",
      "run",
      "typecheck",
      "--force",
    ]);
    expect(step(result, "tests")?.commands).toEqual([
      [
        "bunx",
        "vitest",
        "run",
        "--project",
        "unit",
        "--project",
        "web",
        "--project",
        "db",
        "--project",
        "computer",
      ],
    ]);
  });

  it("runs the tests related to changed modules and every repo-wide test", () => {
    const [command] = step(plan(["docs/a.ts", "docs/testing.md"]), "tests")?.commands ?? [];
    expect(command?.slice(0, 5)).toEqual([
      "bunx",
      "vitest",
      "related",
      "--run",
      "--passWithNoTests",
    ]);
    expect(command?.slice(-3)).toEqual(["docs/a.ts", ...repoTests]);
  });

  it("runs every test in a changed workspace, whatever it imports or reads", () => {
    const command = related(plan(["apps/web/src/a.ts"]));
    expect(command).toEqual(expect.arrayContaining(webTests));
    expect(command).not.toContain("packages/capture/src/capture.test.ts");
    // Deleted files count: the package's tests may have read the file that went.
    expect(related(plan([{ path: "apps/web/public/x.svg", present: false }]))).toEqual(
      expect.arrayContaining(webTests),
    );
    // Never the paid or type-level kinds, and computer suites only by their own rule.
    expect(command.join(" ")).not.toContain("integration");
    // Component tests are reached by import, so the workspace run leaves them to `related`.
    expect(command).not.toContain("apps/web/src/dashboard/session-list.test.tsx");
    expect(step(plan(["packages/sandbox/src/b.ts"]), "tests")?.commands.flat()).not.toContain(
      "packages/sandbox/src/desktop-start.computer.test.ts",
    );
  });

  it("runs a computer suite only when it or its namesake changed, after the related run", () => {
    const byImport = step(plan(["packages/shared/src/events.ts"]), "tests")?.commands ?? [];
    expect(byImport).toHaveLength(1);
    expect(byImport.flat()).not.toContain("computer");

    for (const changed of [
      "packages/sandbox/src/desktop-start.ts",
      "packages/sandbox/src/desktop-start.computer.test.ts",
      // In another folder, under another name, but the suite reads it as text.
      "packages/sandbox/desktop/start-desktop.sh",
    ]) {
      expect(step(plan([changed]), "tests")?.commands[1]).toEqual([
        "bunx",
        "vitest",
        "run",
        "--project",
        "computer",
        "packages/sandbox/src/desktop-start.computer.test.ts",
      ]);
    }
    // Same name, different folder: not its namesake.
    expect(step(plan(["apps/api/src/desktop-start.ts"]), "tests")?.commands).toHaveLength(1);
  });

  it("runs the tests that name a changed file `related` cannot follow", () => {
    expect(related(plan([".gitignore"]))).toContain("packages/bench/src/results-dir.test.ts");
    expect(related(plan(["packages/db/drizzle/0022_project_name_source.sql"]))).toContain(
      "packages/db/src/schema.db.test.ts",
    );
    // Deleted files count: the test that read one now fails to find it.
    expect(related(plan([{ path: ".gitignore", present: false }]))).toContain(
      "packages/bench/src/results-dir.test.ts",
    );
  });

  it("does not look up names that every fixture uses, or tests that never run here", () => {
    expect(related(plan(["packages/capture/package.json"]))).not.toContain(
      "packages/sandbox/src/git-local.test.ts",
    );
    expect(related(plan(["notes/notes.md"])).join(" ")).not.toContain("integration");
  });

  it("hands JSON to `related`, which follows JSON imports, and looks it up by name too", () => {
    expect(related(plan(["apps/web/src/testing/audit-session.json"]))).toContain(
      "apps/web/src/testing/audit-session.json",
    );
    expect(related(plan(["apps/api/tsconfig.json"]))).toContain("apps/api/src/compose.test.ts");
  });

  it("runs a test that reads another tree when anything in that tree changed", () => {
    expect(related(plan(["harbor/README.md"]))).toContain(
      "apps/napbench/src/harbor-agreement.test.ts",
    );
    expect(
      step(plan(["apps/napbench/fixtures/app-test/cart/app.js"]), "tests")?.commands[1],
    ).toEqual([
      "bunx",
      "vitest",
      "run",
      "--project",
      "computer",
      "apps/napbench/scripts/app-test-command.computer.test.ts",
    ]);
    expect(related(plan(["packages/shared/src/a.ts"]))).not.toContain(
      "apps/napbench/src/harbor-agreement.test.ts",
    );
  });

  it("runs a test that starts a script when anything that script reaches changed", () => {
    // Imported by the script, and depended on by what it imports.
    expect(related(plan(["packages/bench/src/app-test.ts"]))).toContain(runner);
    expect(related(plan(["packages/shared/src/a.ts"]))).toContain(runner);
    // apps/web is not among them.
    expect(related(plan(["apps/web/src/a.ts"]))).not.toContain(runner);
  });

  it("runs a whole project when its setup file changed, if that project runs here", () => {
    expect(step(plan(["apps/web/src/testing/setup.ts"]), "tests")?.commands.at(-1)).toEqual([
      "bunx",
      "vitest",
      "run",
      "--project",
      "web",
    ]);
    expect(
      step(plan(["packages/db/src/testing/global-setup.ts"]), "tests")?.commands.at(-1),
    ).toEqual(["bunx", "vitest", "run", "--project", "db"]);
    expect(
      step(plan(["packages/db/src/testing/global-setup.ts"], false), "tests")?.commands,
    ).toHaveLength(1);
    expect(step(plan(["test/integration-setup.ts"]), "tests")?.commands).toHaveLength(1);
  });

  it("checks the whole repo with Biome when its configuration, ignore file or a global changed", () => {
    for (const path of ["biome.json", ".gitignore", "bun.lock"]) {
      expect(step(plan([path]), "biome")?.commands, path).toEqual([
        ["bunx", "biome", "check", "."],
      ]);
    }
    expect(step(plan(["notes/a.md"]), "biome")?.commands[0]).toContain("notes/a.md");
  });

  // Every member of each rule, so dropping one fails here rather than in CI.
  it.each([
    "bun.lock",
    "tsconfig.base.json",
    "tsconfig.test-d.json",
    "turbo.json",
    "vitest.config.ts",
  ])("treats %s as a change to the whole repo", (path) => {
    const result = plan([path]);
    expect(step(result, "typecheck")?.commands[0]).toContain("--force");
    expect(step(result, "tests")?.commands[0]?.slice(0, 3)).toEqual(["bunx", "vitest", "run"]);
  });

  it.each(["test/a.ts", "scripts/a.ts", "vitest.config.ts", "tsconfig.json"])(
    "typechecks the root program when %s changes",
    (path) => {
      expect(step(plan([path]), "typecheck")?.commands.at(-1)).toEqual(["bunx", "tsc", "--noEmit"]);
    },
  );

  it.each(["harbor/a.py", "apps/x/a.py", "harbor/pyproject.toml", "harbor/uv.lock"])(
    "runs the Python gates when %s changes",
    (path) => {
      expect(step(plan([path]), "python")).toBeDefined();
    },
  );

  it("never selects the integration or types project", () => {
    for (const result of [plan(["packages/shared/src/a.ts"]), plan(["bun.lock"])]) {
      const command = step(result, "tests")?.commands.flat() ?? [];
      expect(command).not.toContain("integration");
      expect(command).not.toContain("types");
    }
  });

  it("leaves the db project out, and says so, when Docker is not running", () => {
    const result = plan(["packages/shared/src/a.ts"], false);
    expect(step(result, "tests")?.commands.flat()).not.toContain("db");
    expect(result.notes).toEqual(["db tests skipped: Docker is not running. CI runs them."]);
    expect(step(plan(["packages/shared/src/a.ts"]), "tests")?.commands.flat()).toContain("db");
  });

  it("passes deleted files to no tool, but still typechecks the package they left", () => {
    const result = plan([{ path: "packages/shared/src/gone.ts", present: false }]);
    expect(step(result, "biome")).toBeUndefined();
    expect(step(result, "tests")?.commands.flat()).not.toContain("packages/shared/src/gone.ts");
    expect(step(result, "typecheck")?.commands[0]).toContain("--filter=...@nap/shared");
  });

  it("runs the Python gates and the cross-language test when harbor/ Python changes", () => {
    const result = plan(["harbor/napbench_harbor/agent.py"]);
    expect(step(result, "python")?.commands).toEqual([
      ["bun", "run", "lint:py"],
      ["bun", "run", "test:py"],
      [
        "uv",
        "run",
        "--directory",
        "harbor",
        "--extra",
        "harbor",
        "--with",
        "pytest",
        "pytest",
        "-q",
      ],
    ]);
    expect(step(result, "tests")?.commands.flat()).toContain(
      "apps/napbench/src/harbor-agreement.test.ts",
    );
    expect(step(plan(["harbor/README.md"]), "python")).toBeUndefined();
    expect(step(plan(["packages/shared/src/a.ts"]), "python")).toBeUndefined();
  });

  it("hands Biome every present file and lets Biome skip the kinds it cannot read", () => {
    expect(step(plan(["a.py", "b.ts"]), "biome")?.commands).toEqual([
      [
        "bunx",
        "biome",
        "check",
        "--no-errors-on-unmatched",
        "--files-ignore-unknown=true",
        "a.py",
        "b.ts",
      ],
    ]);
  });
});

// The rules above use made-up paths; these hold them to the files that exist today, so a rule
// cannot keep passing while the file it was written for has moved.
// These read every test file and run git, which takes seconds on a loaded machine.
describe("planChecks on the real tree", { timeout: 30_000 }, () => {
  const root = process.cwd();
  const planFor = async (paths: string[]) => planChecks(await readInputs(root, paths, false));

  it("runs the desktop build hash test for every desktop source", async () => {
    const result = await planFor([...DESKTOP_SOURCES]);
    expect(related(result)).toContain("packages/sandbox/src/desktop-build.test.ts");
    for (const path of DESKTOP_SOURCES) {
      expect(related(plan([path])), path).toContain("packages/sandbox/src/desktop-build.test.ts");
    }
  });

  it("runs the desktop start suite when the start script changes", async () => {
    const result = await planFor(["packages/sandbox/desktop/start-desktop.sh"]);
    expect(step(result, "tests")?.commands.flat()).toContain(
      "packages/sandbox/src/desktop-start.computer.test.ts",
    );
  });

  it("lists every component test that reads the filesystem, since the workspace run skips them", () => {
    const tracked = execFileSync("git", ["ls-files", "-z", "*.test.tsx"], { encoding: "utf8" })
      .split("\0")
      .filter(Boolean);
    const readers = tracked.filter((path) =>
      /from "(?:node:)?fs(?:\/promises)?"/.test(readFileSync(path, "utf8")),
    );
    expect(readers.length).toBeGreaterThan(0);
    expect(readers.filter((path) => !TREE_READERS.some(({ test }) => test === path))).toEqual([]);
  });

  it("finds the tests that run a script in another process, with what the script imports", async () => {
    const { processRunners: found } = await readInputs(root, [], false);
    expect(found).toMatchObject({
      "apps/napbench/scripts/napbench-app-test.test.ts": expect.arrayContaining(["@nap/bench"]),
      "apps/api/src/computer/image-spike-cli.test.ts": expect.arrayContaining(["@nap/agent"]),
    });
    // The change that slipped through before: an error message the script prints.
    expect(related(await planFor(["packages/bench/src/app-test.ts"]))).toContain(
      "apps/napbench/scripts/napbench-app-test.test.ts",
    );
    // Through package.json: the script imports @nap/bench, which depends on @nap/verify.
    expect(related(await planFor(["packages/verify/src/command-output.ts"]))).toContain(
      "apps/napbench/scripts/napbench-app-test.test.ts",
    );
  });

  it("gives every computer suite a file other than itself that selects it", async () => {
    const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0");
    const suites = tracked.filter((path) => path.endsWith(".computer.test.ts"));
    expect(suites.length).toBeGreaterThan(0);
    const triggersBySuite = new Map<string, string[]>();
    for (const suite of suites) {
      const text = readFileSync(suite, "utf8");
      const stem = suite.replace(/\.computer\.test\.ts$/, "");
      const triggers = tracked.filter(
        (path) =>
          path !== suite &&
          (path.replace(/\.[^/]*$/, "") === stem ||
            (!/\.[cm]?[jt]sx?$/.test(path) &&
              text.includes(path.slice(path.lastIndexOf("/") + 1)))),
      );
      triggersBySuite.set(suite, triggers);
    }
    // One read of the repo for every candidate, then one plan per candidate on its own.
    const inputs = await readInputs(root, [...triggersBySuite.values()].flat(), false);
    for (const [suite, triggers] of triggersBySuite) {
      const chosen = triggers.map(
        (path) =>
          step(
            planChecks({ ...inputs, files: [{ path, present: true }] }),
            "tests",
          )?.commands.flat() ?? [],
      );
      expect(
        chosen.some((command) => command.includes(suite)),
        `${suite} is selected by no change but its own`,
      ).toBe(true);
    }
  });
});

describe("the pre-commit hook", () => {
  it("is check:changed on the staged files, so the hook and the command agree on green", () => {
    const hook = parse(readFileSync("lefthook.yml", "utf8"));
    expect(hook["pre-commit"].jobs.map((job: { run: string }) => job.run)).toEqual([
      "bun run check:changed --staged",
    ]);
  });
});
