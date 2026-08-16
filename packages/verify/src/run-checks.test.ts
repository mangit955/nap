/**
 * Ordering and short-circuiting are the whole behaviour here, so most of these assert on the
 * commands the sandbox was actually asked to run rather than on the verdict alone: a run that
 * reaches the right answer by executing every check has still burned a minute of a repair loop.
 */

import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import { describe, expect, it } from "vitest";
import type { DiscoveredCheck } from "./discover-checks.ts";
import { runChecks } from "./run-checks.ts";

const PORT = 5173;

const runnable = (name: DiscoveredCheck["name"]): DiscoveredCheck => ({
  name,
  state: "runnable",
  command: `run-${name}`,
});

const absent = (name: DiscoveredCheck["name"]): DiscoveredCheck => ({ name, state: "absent" });

const ALL: DiscoveredCheck[] = [
  runnable("typecheck"),
  runnable("lint"),
  runnable("build"),
  runnable("test"),
];

async function sandboxWith(options: { serving?: boolean; destroyed?: boolean } = {}) {
  const sandbox = new InMemorySandboxManager({
    serves: options.serving === true ? [PORT] : [],
    defaultExec: () => ({ exitCode: 0 }),
  });
  const created = await sandbox.create(crypto.randomUUID());
  if (!created.ok) throw new Error("the fake refused to create a sandbox");
  if (options.destroyed === true) await sandbox.destroy(created.value.id);
  return { sandbox, sandboxId: created.value.id };
}

const outcomes = (result: { checks: readonly { name: string; outcome: string }[] }) =>
  result.checks.map((check) => [check.name, check.outcome]);

describe("runChecks", () => {
  it("runs the checks in the order it was given", async () => {
    const { sandbox, sandboxId } = await sandboxWith();

    const result = await runChecks(sandbox, sandboxId, ALL);

    expect(sandbox.commands(sandboxId)).toEqual([
      "run-typecheck",
      "run-lint",
      "run-build",
      "run-test",
    ]);
    expect(result.verdict).toBe("passed");
    expect(outcomes(result)).toEqual([
      ["typecheck", "passed"],
      ["lint", "passed"],
      ["build", "passed"],
      ["test", "passed"],
    ]);
  });

  it("does not run a check the project never declared, and does not fail it either", async () => {
    const { sandbox, sandboxId } = await sandboxWith();

    const result = await runChecks(sandbox, sandboxId, [
      runnable("typecheck"),
      absent("lint"),
      absent("build"),
      absent("test"),
    ]);

    expect(sandbox.commands(sandboxId)).toEqual(["run-typecheck"]);
    expect(result.verdict).toBe("passed");
    expect(outcomes(result)).toEqual([
      ["typecheck", "passed"],
      ["lint", "absent"],
      ["build", "absent"],
      ["test", "absent"],
    ]);
  });

  it("passes a project that declares no checks at all", async () => {
    const { sandbox, sandboxId } = await sandboxWith();

    const result = await runChecks(sandbox, sandboxId, [absent("typecheck"), absent("test")]);

    expect(sandbox.commands(sandboxId)).toEqual([]);
    expect(result.verdict).toBe("passed");
  });

  it("stops at the first failure and leaves the later checks unasked", async () => {
    const { sandbox, sandboxId } = await sandboxWith();
    sandbox.script("run-lint", { exitCode: 1 });

    const result = await runChecks(sandbox, sandboxId, ALL);

    expect(sandbox.commands(sandboxId)).toEqual(["run-typecheck", "run-lint"]);
    expect(result.verdict).toBe("failed");
    expect(outcomes(result)).toEqual([
      ["typecheck", "passed"],
      ["lint", "failed"],
      ["build", "absent"],
      ["test", "absent"],
    ]);
  });

  it("says why a later check was not asked, so it is not read as a missing script", async () => {
    const { sandbox, sandboxId } = await sandboxWith();
    sandbox.script("run-typecheck", { exitCode: 2 });

    const result = await runChecks(sandbox, sandboxId, ALL);

    const [typecheck, lint] = result.checks;
    expect(typecheck?.detail).toContain("exit 2");
    expect(lint?.detail).toContain("typecheck");
  });

  it("keeps what a failing check said, and nothing from the ones that passed", async () => {
    const { sandbox, sandboxId } = await sandboxWith();
    sandbox.script("run-typecheck", { exitCode: 0, stdout: "all good\n" });
    sandbox.script("run-lint", { exitCode: 1, stderr: "Script not found\n" });

    const result = await runChecks(sandbox, sandboxId, [runnable("typecheck"), runnable("lint")]);

    expect(result.checks[0]?.output).toBeUndefined();
    expect(result.checks[1]?.output?.stderr.text).toBe("Script not found\n");
  });

  it("budgets that output rather than keeping all of it", async () => {
    const { sandbox, sandboxId } = await sandboxWith();
    sandbox.script("run-build", { exitCode: 1, stdout: "x".repeat(10_000) });

    const result = await runChecks(sandbox, sandboxId, [runnable("build")]);

    expect(result.checks[0]?.output?.stdout.truncated).toBe(true);
  });

  it("errors rather than fails when the sandbox refuses the command", async () => {
    const { sandbox, sandboxId } = await sandboxWith({ destroyed: true });

    const result = await runChecks(sandbox, sandboxId, ALL);

    // Nothing was learned about the project, so nothing is charged to it — and a repair turn
    // against a sandbox that is gone would spend tokens on a problem the model cannot see.
    expect(result.verdict).toBe("errored");
    expect(outcomes(result)).toEqual([
      ["typecheck", "absent"],
      ["lint", "absent"],
      ["build", "absent"],
      ["test", "absent"],
    ]);
    expect(result.checks[0]?.detail).toContain("destroyed");
  });

  describe("the preview probe", () => {
    it("runs last, after every command check", async () => {
      const { sandbox, sandboxId } = await sandboxWith({ serving: true });

      const result = await runChecks(sandbox, sandboxId, ALL, { preview: { port: PORT } });

      expect(result.checks.at(-1)?.name).toBe("preview");
      expect(result.checks.at(-1)?.outcome).toBe("passed");
      expect(result.verdict).toBe("passed");
    });

    it("is not part of the answer when the caller did not ask for one", async () => {
      const { sandbox, sandboxId } = await sandboxWith({ serving: true });

      const result = await runChecks(sandbox, sandboxId, ALL);

      expect(result.checks.map((check) => check.name)).not.toContain("preview");
    });

    it("is not reached when an earlier check failed", async () => {
      const { sandbox, sandboxId } = await sandboxWith({ serving: false });
      sandbox.script("run-typecheck", { exitCode: 1 });

      const result = await runChecks(sandbox, sandboxId, ALL, { preview: { port: PORT } });

      expect(sandbox.commands(sandboxId)).toEqual(["run-typecheck"]);
      expect(result.checks.at(-1)).toMatchObject({ name: "preview", outcome: "absent" });
      expect(result.verdict).toBe("failed");
    });

    it("fails when the application did not start", async () => {
      const { sandbox, sandboxId } = await sandboxWith({ serving: false });
      // curl's "could not connect", from inside: nothing is listening on the port.
      sandbox.script(/^curl /, { exitCode: 7 });

      const result = await runChecks(sandbox, sandboxId, [], { preview: { port: PORT } });

      expect(result.verdict).toBe("failed");
      expect(result.checks.at(-1)).toMatchObject({ name: "preview", outcome: "failed" });
    });

    it("errors when the preview is unreachable, rather than blaming the application", async () => {
      const { sandbox, sandboxId } = await sandboxWith({ serving: false });
      // Listening inside, unanswered outside: the proxy, which no repair turn can fix.
      sandbox.script(/^curl /, { exitCode: 0 });

      const result = await runChecks(sandbox, sandboxId, [], { preview: { port: PORT } });

      expect(result.verdict).toBe("errored");
      expect(result.checks.at(-1)).toMatchObject({ name: "preview", outcome: "absent" });
    });
  });
});
