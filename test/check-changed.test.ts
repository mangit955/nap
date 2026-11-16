import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { type ChangedFile, type Plan, planChecks } from "../scripts/check-changed.ts";

const workspaces = [
  { name: "@nap/shared", dir: "packages/shared" },
  { name: "@nap/capture", dir: "packages/capture" },
  { name: "@nap/web", dir: "apps/web" },
];
const repoTests = ["test/architecture.test.ts", "test/docs.test.ts"];
const computerTests = [
  "packages/sandbox/src/desktop-start.computer.test.ts",
  "apps/api/scripts/local-sandbox.computer.test.ts",
];

function plan(paths: readonly (string | ChangedFile)[], docker = true): Plan {
  const files = paths.map((path) => (typeof path === "string" ? { path, present: true } : path));
  return planChecks({ files, workspaces, docker, repoTests, computerTests });
}
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
    expect(step(result, "typecheck")?.commands[0]).toEqual(["bunx", "turbo", "run", "typecheck"]);
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
    const [command] =
      step(plan(["apps/web/src/a.tsx", "docs/testing.md"]), "tests")?.commands ?? [];
    expect(command?.slice(0, 5)).toEqual([
      "bunx",
      "vitest",
      "related",
      "--run",
      "--passWithNoTests",
    ]);
    expect(command?.slice(-3)).toEqual(["apps/web/src/a.tsx", ...repoTests]);
  });

  it("runs a computer suite only when it or its namesake changed, after the related run", () => {
    const byImport = step(plan(["packages/shared/src/events.ts"]), "tests")?.commands ?? [];
    expect(byImport).toHaveLength(1);
    expect(byImport.flat()).not.toContain("computer");

    for (const changed of [
      "packages/sandbox/src/desktop-start.sh",
      "packages/sandbox/src/desktop-start.computer.test.ts",
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

describe("the pre-commit hook", () => {
  it("is check:changed on the staged files, so the hook and the command agree on green", () => {
    const hook = parse(readFileSync("lefthook.yml", "utf8"));
    expect(hook["pre-commit"].jobs.map((job: { run: string }) => job.run)).toEqual([
      "bun run check:changed --staged",
    ]);
  });
});
