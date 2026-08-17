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
});
