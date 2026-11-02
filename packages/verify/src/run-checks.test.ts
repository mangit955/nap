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
    expect(lint?.detail).toBe("not run: typecheck failed first");
  });

  it("distinguishes a check stopped by a failure from one stopped by a dead sandbox", async () => {
    const { sandbox, sandboxId } = await sandboxWith({ destroyed: true });

    const result = await runChecks(sandbox, sandboxId, ALL);

    // Both are absent, and a repair prompt that read "typecheck failed first" here would send
    // the model looking for a type error that nobody ever asked about.
    expect(result.checks[1]?.detail).toBe("not run: typecheck could not be run");
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

describe("a typecheck and a lint known to be independent", () => {
  const trusted = (name: DiscoveredCheck["name"]): DiscoveredCheck => ({
    name,
    state: "runnable",
    command: `run-${name}`,
    readOnly: true,
  });
  const TRUSTED_ALL: DiscoveredCheck[] = [
    trusted("typecheck"),
    trusted("lint"),
    runnable("build"),
    runnable("test"),
  ];

  /** Answers a command only once both of the pair have been asked, so a queue deadlocks here. */
  function meetingInTheMiddle(sandbox: InMemorySandboxManager) {
    let arrived = 0;
    let bothHere: () => void = () => {};
    const meeting = new Promise<void>((resolve) => {
      bothHere = resolve;
    });
    sandbox.script(/run-(typecheck|lint)/, async () => {
      arrived += 1;
      if (arrived === 2) bothHere();
      await meeting;
      return { exitCode: 0 };
    });
  }

  it("runs them at the same time when both pass", async () => {
    const { sandbox, sandboxId } = await sandboxWith();
    meetingInTheMiddle(sandbox);

    const result = await runChecks(sandbox, sandboxId, TRUSTED_ALL);

    expect(result.verdict).toBe("passed");
    expect(sandbox.commands(sandboxId)).toEqual([
      "run-typecheck",
      "run-lint",
      "run-build",
      "run-test",
    ]);
    expect(outcomes(result)).toEqual([
      ["typecheck", "passed"],
      ["lint", "passed"],
      ["build", "passed"],
      ["test", "passed"],
    ]);
  });

  it("starts the build only once both have finished", async () => {
    const { sandbox, sandboxId } = await sandboxWith();
    let lintFinished = false;
    sandbox.script("run-lint", async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
      lintFinished = true;
      return { exitCode: 0 };
    });
    let lintFinishedAtBuild = false;
    sandbox.script("run-build", () => {
      lintFinishedAtBuild = lintFinished;
      return { exitCode: 0 };
    });

    await runChecks(sandbox, sandboxId, TRUSTED_ALL);

    expect(lintFinishedAtBuild).toBe(true);
  });

  it("does not run them together when either one cannot be vouched for", async () => {
    const { sandbox, sandboxId } = await sandboxWith();
    let running = 0;
    let peak = 0;
    sandbox.script(/run-(typecheck|lint)/, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running -= 1;
      return { exitCode: 0 };
    });

    await runChecks(sandbox, sandboxId, [trusted("typecheck"), runnable("lint")]);

    expect(peak).toBe(1);
  });

  it("does nothing special for a project that declares only one of them", async () => {
    const { sandbox, sandboxId } = await sandboxWith();

    const result = await runChecks(sandbox, sandboxId, [trusted("typecheck"), absent("lint")]);

    expect(sandbox.commands(sandboxId)).toEqual(["run-typecheck"]);
    expect(result.verdict).toBe("passed");
  });

  /** Runs a scenario through the pair, and through checks nothing ever ran together. */
  async function bothWays(
    answer: (name: string) => { exitCode: number; stderr?: string } | undefined,
    finishFirst: "typecheck" | "lint",
  ) {
    const respond = (name: string) => async () => {
      await new Promise((resolve) => setTimeout(resolve, name === finishFirst ? 0 : 5));
      return answer(name) ?? { exitCode: 0 };
    };
    const script = (sandbox: InMemorySandboxManager) => {
      for (const name of ["typecheck", "lint", "build", "test"]) {
        sandbox.script(`run-${name}`, respond(name));
      }
    };

    const together = await sandboxWith();
    script(together.sandbox);
    const apart = await sandboxWith();
    script(apart.sandbox);

    return {
      together: await runChecks(together.sandbox, together.sandboxId, TRUSTED_ALL),
      apart: await runChecks(apart.sandbox, apart.sandboxId, ALL),
    };
  }

  it.each([
    ["the typecheck failing", { typecheck: 1 }],
    ["the lint failing", { lint: 1 }],
    ["both failing", { typecheck: 1, lint: 1 }],
  ])("reports %s exactly as running them apart would", async (_, exits) => {
    const answer = (name: string) => {
      const exitCode = (exits as Record<string, number>)[name];
      return exitCode === undefined ? undefined : { exitCode, stderr: `${name} said no` };
    };

    for (const finishFirst of ["typecheck", "lint"] as const) {
      const { together, apart } = await bothWays(answer, finishFirst);
      expect(together).toStrictEqual(apart);
    }
  });

  it("does not charge the project for a check that only failed because of its neighbour", async () => {
    // Two compilers in a one-gigabyte sandbox can get one of them killed, and a 137 read as a lint
    // failure opens a repair turn that a model pays for and nothing can fix. Alone, it passes.
    const { sandbox, sandboxId } = await sandboxWith();
    let attempts = 0;
    sandbox.script("run-lint", () => {
      attempts += 1;
      return attempts === 1 ? { exitCode: 137 } : { exitCode: 0 };
    });

    const result = await runChecks(sandbox, sandboxId, TRUSTED_ALL);

    expect(result.verdict).toBe("passed");
    expect(attempts).toBe(2);
    // The typecheck beside it passed, and is not asked again.
    expect(sandbox.commands(sandboxId)).toEqual([
      "run-typecheck",
      "run-lint",
      "run-lint",
      "run-build",
      "run-test",
    ]);
  });

  it("asks nothing more when the typecheck fails beside the lint", async () => {
    // Alone, the typecheck would have been the only command. The lint already ran beside it, and
    // running either again would only repeat an answer the run is about to stop on.
    const { sandbox, sandboxId } = await sandboxWith();
    sandbox.script("run-typecheck", { exitCode: 2, stderr: "TS2322" });

    const result = await runChecks(sandbox, sandboxId, TRUSTED_ALL);

    expect(sandbox.commands(sandboxId)).toEqual(["run-typecheck", "run-lint"]);
    expect(result.verdict).toBe("failed");
    expect(result.checks[1]?.detail).toBe("not run: typecheck failed first");
  });

  it("asks nothing more when the lint fails beside a passing typecheck", async () => {
    const { sandbox, sandboxId } = await sandboxWith();
    sandbox.script("run-lint", { exitCode: 1, stderr: "no-unused-vars" });

    const result = await runChecks(sandbox, sandboxId, TRUSTED_ALL);

    expect(sandbox.commands(sandboxId)).toEqual(["run-typecheck", "run-lint"]);
    expect(result.verdict).toBe("failed");
    expect(outcomes(result).slice(0, 2)).toEqual([
      ["typecheck", "passed"],
      ["lint", "failed"],
    ]);
  });

  it("does not run again a check that could not be run at all", async () => {
    // A command that never answered — the sandbox went, or the command timed out — would most
    // likely not answer a second time either, and waiting for it twice doubles the wait.
    const { sandbox, sandboxId } = await sandboxWith();
    sandbox.script("run-typecheck", { error: { code: "timeout", message: "no answer" } });

    const result = await runChecks(sandbox, sandboxId, TRUSTED_ALL);

    expect(sandbox.commands(sandboxId)).toEqual(["run-typecheck", "run-lint"]);
    expect(result.verdict).toBe("errored");
    expect(result.checks[1]?.detail).toBe("not run: typecheck could not be run");
  });

  it("runs a killed typecheck again on its own, and uses what it says alone", async () => {
    const { sandbox, sandboxId } = await sandboxWith();
    let attempts = 0;
    sandbox.script("run-typecheck", () => {
      attempts += 1;
      return attempts === 1 ? { exitCode: 134 } : { exitCode: 2, stderr: "TS2322" };
    });

    const result = await runChecks(sandbox, sandboxId, TRUSTED_ALL);

    expect(sandbox.commands(sandboxId)).toEqual(["run-typecheck", "run-lint", "run-typecheck"]);
    expect(result.checks[0]).toMatchObject({
      name: "typecheck",
      outcome: "failed",
      detail: "exit 2",
    });
    expect(result.checks[1]?.detail).toBe("not run: typecheck failed first");
  });

  it("does not ask the passing lint again when only the typecheck beside it was killed", async () => {
    const { sandbox, sandboxId } = await sandboxWith();
    let attempts = 0;
    sandbox.script("run-typecheck", () => {
      attempts += 1;
      return attempts === 1 ? { exitCode: 137 } : { exitCode: 0 };
    });

    const result = await runChecks(sandbox, sandboxId, TRUSTED_ALL);

    expect(result.verdict).toBe("passed");
    expect(sandbox.commands(sandboxId)).toEqual([
      "run-typecheck",
      "run-lint",
      "run-typecheck",
      "run-build",
      "run-test",
    ]);
  });

  describe("reports every pairing of answers exactly as running them apart would", () => {
    /** What a check says on its own, and whether running it beside the other got it killed. */
    type Side = { alone: "passes" | "fails" | "errors"; killedBeside: boolean };
    const sides: Side[] = (["passes", "fails", "errors"] as const).flatMap((alone) => [
      { alone, killedBeside: false },
      { alone, killedBeside: true },
    ]);
    const answerAlone = (name: string, side: Side) =>
      side.alone === "passes"
        ? { exitCode: 0 }
        : side.alone === "fails"
          ? { exitCode: 1, stderr: `${name} said no` }
          : { error: { code: "unavailable" as const, message: `${name} went away` } };
    const label = (side: Side) => `${side.alone}${side.killedBeside ? " (killed beside)" : ""}`;

    const pairings = sides.flatMap((typecheck) =>
      sides.map((lint) => [label(typecheck), label(lint), typecheck, lint] as const),
    );

    it.each(pairings)("a typecheck that %s and a lint that %s", async (_t, _l, typecheck, lint) => {
      const script = (sandbox: InMemorySandboxManager, together: boolean) => {
        for (const [name, side] of [
          ["typecheck", typecheck],
          ["lint", lint],
        ] as const) {
          let calls = 0;
          sandbox.script(`run-${name}`, () => {
            calls += 1;
            if (together && side.killedBeside && calls === 1) return { exitCode: 137 };
            return answerAlone(name, side);
          });
        }
      };

      const together = await sandboxWith();
      script(together.sandbox, true);
      const apart = await sandboxWith();
      script(apart.sandbox, false);

      const pairResult = await runChecks(together.sandbox, together.sandboxId, TRUSTED_ALL);
      const alone = await runChecks(apart.sandbox, apart.sandboxId, ALL);

      expect(pairResult).toStrictEqual(alone);

      // Both were started together, and only a killed one is ever asked again.
      const reran = together.sandbox.commands(together.sandboxId).slice(2);
      if (!typecheck.killedBeside) expect(reran).not.toContain("run-typecheck");
      if (!lint.killedBeside) expect(reran).not.toContain("run-lint");
    });
  });

  it("errors rather than fails when the sandbox goes away under the pair", async () => {
    const { sandbox, sandboxId } = await sandboxWith({ destroyed: true });

    const result = await runChecks(sandbox, sandboxId, TRUSTED_ALL);

    expect(result.verdict).toBe("errored");
    expect(result.checks[1]?.detail).toBe("not run: typecheck could not be run");
  });
});
