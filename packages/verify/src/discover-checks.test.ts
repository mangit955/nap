import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import { describe, expect, it } from "vitest";
import { CHECK_NAMES, type DiscoveredCheck, discoverChecks } from "./discover-checks.ts";

/** The command a project would run for `name`, with nothing appended. */
function plainCommand(name: string): string {
  return `cd ${PROJECT_ROOT_PATH} && bun run ${name}`;
}

function packageJson(scripts: Record<string, unknown>): string {
  return JSON.stringify({ name: "nap-app", private: true, scripts });
}

function checkNamed(checks: DiscoveredCheck[], name: string): DiscoveredCheck {
  const check = checks.find((candidate) => candidate.name === name);
  if (check === undefined) throw new Error(`no check named ${name} was discovered`);
  return check;
}

describe("discoverChecks", () => {
  it("answers for every check name, cheapest first", () => {
    const checks = discoverChecks(packageJson({}));

    expect(checks.map((check) => check.name)).toEqual(["typecheck", "lint", "build", "test"]);
    expect(CHECK_NAMES).toEqual(["typecheck", "lint", "build", "test"]);
  });

  it("turns a declared script into a command that runs it in the project root", () => {
    const checks = discoverChecks(packageJson({ build: "vite build", lint: "biome check ." }));

    expect(checkNamed(checks, "build")).toEqual({
      name: "build",
      state: "runnable",
      command: plainCommand("build"),
    });
    expect(checkNamed(checks, "lint")).toEqual({
      name: "lint",
      state: "runnable",
      command: plainCommand("lint"),
      readOnly: true,
    });
  });

  it("calls a script the project does not declare absent rather than failed", () => {
    const checks = discoverChecks(packageJson({ build: "vite build" }));

    // The distinction this whole ticket exists for: a fresh project with no test script has
    // not failed its tests, and a failure here is a repair loop nothing can close.
    expect(checkNamed(checks, "test")).toEqual({ name: "test", state: "absent" });
    expect(checkNamed(checks, "typecheck")).toEqual({ name: "typecheck", state: "absent" });
  });

  it("ignores scripts that are not checks", () => {
    const checks = discoverChecks(packageJson({ dev: "vite --host", preview: "vite preview" }));

    expect(checks.every((check) => check.state === "absent")).toBe(true);
  });

  it("makes a watch-mode vitest script exit", () => {
    // The Vite template's own `"test": "vitest"` never returns: discovery has to produce
    // something runnable, not just the name of a script.
    const checks = discoverChecks(packageJson({ test: "vitest" }));

    expect(checkNamed(checks, "test")).toEqual({
      name: "test",
      state: "runnable",
      command: `${plainCommand("test")} --run`,
    });
  });

  it("leaves a test script that already runs once alone", () => {
    for (const script of [
      "vitest run",
      "vitest run --coverage",
      "vitest --watch=false",
      "node --test",
      // A watcher that is not the last command cannot be fixed by an appended argument, so
      // the flag is not added where it would land on something else.
      "vitest && echo done",
    ]) {
      const checks = discoverChecks(packageJson({ test: script }));

      expect(checkNamed(checks, "test")).toEqual({
        name: "test",
        state: "runnable",
        command: plainCommand("test"),
      });
    }
  });

  it("makes vitest exit however the script reaches it", () => {
    // An appended argument lands on the script's last command, so that is the one the rule
    // reads — `tsc --noEmit && vitest` is flagged, and a `run` earlier in the line is not
    // mistaken for vitest having been asked to run once.
    for (const script of [
      "vitest --watch",
      "bunx vitest",
      "npm run something && vitest",
      // The launchers are themselves spelled with `run`, and reading that as vitest's own
      // leaves the watcher going — which is the hang this whole rule exists to prevent.
      "npm run vitest",
      "bun run vitest",
      "pnpm run vitest",
      "./node_modules/.bin/vitest",
    ]) {
      const checks = discoverChecks(packageJson({ test: script }));

      expect(checkNamed(checks, "test")).toEqual({
        name: "test",
        state: "runnable",
        command: `${plainCommand("test")} --run`,
      });
    }
  });

  it("treats a blank or non-string script as no script at all", () => {
    const checks = discoverChecks(packageJson({ lint: "   ", build: 3, test: null }));

    expect(checks.every((check) => check.state === "absent")).toBe(true);
  });

  it("discovers nothing from a package.json it cannot read", () => {
    // Nothing was asked, so nothing failed. A project whose manifest is broken will hear
    // about it from the model's next turn rather than from a check that was never run.
    for (const contents of ["", "{ not json", "[]", '"a string"', "null"]) {
      const checks = discoverChecks(contents);

      expect(checks).toHaveLength(CHECK_NAMES.length);
      expect(checks.every((check) => check.state === "absent")).toBe(true);
    }
  });

  describe("which checks are known to leave the workspace alone", () => {
    const readOnly = (name: "typecheck" | "lint" | "build" | "test", script: string) => {
      const check = checkNamed(discoverChecks(packageJson({ [name]: script })), name);
      return check.state === "runnable" && check.readOnly === true;
    };

    it.each([
      "tsc --noEmit",
      "tsc --noEmit -p tsconfig.app.json",
      "bunx tsc --noEmit",
      "npx tsc --noEmit",
      "pnpm exec tsc --noEmit",
      "vue-tsc --noEmit",
    ])("trusts a typecheck of `%s`", (script) => {
      expect(readOnly("typecheck", script)).toBe(true);
    });

    it.each([
      // Without `--noEmit` nobody here knows what the tsconfig asks for.
      "tsc",
      "tsc -p .",
      "tsc --build",
      "tsc -b --noEmit",
      // More than one command, so this is no longer a claim about one tool.
      "tsc --noEmit && eslint --fix .",
      "next build; tsc --noEmit",
      "tsc --noEmit > report.txt",
      "$(./prepare.sh) tsc --noEmit",
      "./scripts/typecheck.sh",
      "something-else --noEmit",
      // A boolean flag followed by `false` is turned off, so this one emits.
      "tsc --noEmit false",
      "tsc --noEmit false -p .",
      // Never exits, so it would hold the lint's slot until the deadline.
      "tsc --noEmit --watch",
      "tsc --noEmit -w",
      // Both write files into the project, which a linter beside it may be reading.
      "tsc --noEmit --generateTrace trace",
      "tsc --noEmit --generateCpuProfile profile.cpuprofile",
    ])("does not trust a typecheck of `%s`", (script) => {
      expect(readOnly("typecheck", script)).toBe(false);
    });

    it.each([
      "eslint .",
      "eslint src --ext .ts",
      "eslint --cache .",
      "biome check .",
      "biome lint src",
      "biome ci .",
      "oxlint",
      "bunx eslint .",
    ])("trusts a lint of `%s`", (script) => {
      expect(readOnly("lint", script)).toBe(true);
    });

    it.each([
      "eslint --fix .",
      "eslint . --fix",
      "eslint --fix-dry-run .",
      "biome check --write .",
      "biome check --apply .",
      "biome check --write --unsafe .",
      "biome format --write .",
      "next lint",
      "eslint . && prettier --write .",
      "prettier --check .",
      "eslint . -o report.json",
      "eslint . --output-file report.json",
      "eslint . --output-file=report.json",
      "oxlint -o=report.json",
      "biome check --write=true .",
      "biome check --fix=true .",
      "biome check --apply=true .",
    ])("does not trust a lint of `%s`", (script) => {
      expect(readOnly("lint", script)).toBe(false);
    });

    /** Whether `name` is trusted when the manifest declares `script` and these others beside it. */
    const readOnlyBeside = (name: "typecheck" | "lint", script: string, others: object) => {
      const check = checkNamed(discoverChecks(packageJson({ [name]: script, ...others })), name);
      return check.state === "runnable" && check.readOnly === true;
    };

    it.each([
      ["typecheck", "tsc --noEmit", { pretypecheck: "prisma generate" }],
      ["typecheck", "tsc --noEmit", { posttypecheck: "rm -rf .cache" }],
      ["lint", "eslint .", { prelint: "eslint --fix ." }],
      ["lint", "eslint .", { postlint: "prettier --write ." }],
    ] as const)(
      "does not trust a %s of `%s` once %o is declared, because bun runs it too",
      (name, script, others) => {
        // `bun run lint` runs `prelint` first and `postlint` after, so what the check does is no
        // longer only what its own script says.
        expect(readOnlyBeside(name, script, others)).toBe(false);
      },
    );

    it("is not put off by a lifecycle script that belongs to some other name", () => {
      const others = {
        prebuild: "rm -rf dist",
        postbuild: "echo done",
        pretest: "echo",
        prelint: "",
      };

      expect(readOnlyBeside("typecheck", "tsc --noEmit", others)).toBe(true);
      // Declared, but empty, so there is nothing for bun to run.
      expect(readOnlyBeside("lint", "eslint .", others)).toBe(true);
    });

    it("never trusts a build or a test, whatever they are spelled", () => {
      // A build writes its output directory and a test may read it, which is the whole reason the
      // pair stays apart: `vite build` and `tsc --noEmit` are both fine alone.
      expect(readOnly("build", "tsc --noEmit")).toBe(false);
      expect(readOnly("build", "vite build")).toBe(false);
      expect(readOnly("test", "tsc --noEmit")).toBe(false);
      expect(readOnly("test", "vitest")).toBe(false);
    });
  });
});
