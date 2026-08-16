/**
 * Running a project's checks and saying what happened — the system's half of a turn.
 *
 * The model claims the work is done; this is what the system finds (`docs/adr/0006`). It runs
 * the checks in the order it is handed them, which `discoverChecks` has already put cheapest
 * first, and **stops at the first failure**. That stopping is not an optimisation. The repair
 * loop iterates anyway, so a second attempt costs nothing to arrange, while a build error
 * downstream of a type error is a second wrong answer for the model to chase — and chasing it
 * is how three bounded attempts get spent on the wrong file.
 *
 * **The result is data, never prose.** Its reader is a repair prompt and an event payload, and
 * both need the check's name, its outcome and what it said, separately.
 *
 * **Three verdicts, because two of them are not the project's fault.** `failed` means a check
 * the project asked for said no — that is a repair turn. `errored` means the run learned
 * nothing: the sandbox refused the command, or the preview is listening but unreachable from
 * out here. Opening a repair turn on either would spend tokens asking a model to fix a machine
 * it cannot see, so the checks involved come back *absent* and the verdict carries the fault.
 * Same reading as `diagnosePreview`, and the same one `CheckOutcome` was given three values for.
 */

import type { CheckOutcome } from "@nap/shared/check-outcome";
import type { SandboxManager } from "@nap/shared/ports/sandbox-manager";
import { type CommandOutput, captureCommandOutput } from "./command-output.ts";
import type { CheckName, DiscoveredCheck } from "./discover-checks.ts";
import { diagnosePreview } from "./preview.ts";

/**
 * The preview's name in a result, alongside the four script names.
 *
 * It is a check like the others to everything downstream — the event log, the repair prompt,
 * the job strip — and unlike them to nothing, so it travels as one rather than as a field.
 */
export const PREVIEW_CHECK_NAME = "preview";

export type RanCheckName = CheckName | typeof PREVIEW_CHECK_NAME;

export type RanCheck = {
  name: RanCheckName;
  outcome: CheckOutcome;
  /**
   * Why, in a few words: the exit code, or which earlier check stopped this one being asked.
   *
   * Always present, including on an absent check, because "there is no lint script" and "lint
   * was never reached" are the same outcome and a repair prompt must not confuse them.
   */
  detail: string;
  /** What a failing command said, already budgeted. Absent when it passed or said nothing. */
  output?: CommandOutput;
};

export type VerificationVerdict = "passed" | "failed" | "errored";

export type VerificationResult = {
  verdict: VerificationVerdict;
  /** Every check the caller asked about, in the order asked, whether or not it was run. */
  checks: RanCheck[];
};

export type RunChecksOptions = {
  /**
   * The preview probe, when the project serves something. Omitted for a project that does not,
   * rather than defaulted to a port — a check nobody asked for must not be able to fail.
   */
  preview?: { port: number; timeoutMs?: number };
};

export async function runChecks(
  sandbox: SandboxManager,
  sandboxId: string,
  checks: readonly DiscoveredCheck[],
  options: RunChecksOptions = {},
): Promise<VerificationResult> {
  const ran: RanCheck[] = [];
  /** What ended the run, once something has. Everything after it is recorded unasked. */
  let stopped: { verdict: "failed" | "errored"; by: RanCheckName } | undefined;

  for (const check of checks) {
    if (check.state === "absent") {
      ran.push({ name: check.name, outcome: "absent", detail: notDeclared(check.name) });
      continue;
    }

    if (stopped !== undefined) {
      ran.push({ name: check.name, outcome: "absent", detail: notReached(stopped.by) });
      continue;
    }

    const result = await runOne(sandbox, sandboxId, check);
    ran.push(result.check);
    if (result.stops) stopped = { verdict: result.verdict, by: check.name };
  }

  if (options.preview !== undefined) {
    if (stopped !== undefined) {
      ran.push({
        name: PREVIEW_CHECK_NAME,
        outcome: "absent",
        detail: notReached(stopped.by),
      });
    } else {
      const result = await probePreview(sandbox, sandboxId, options.preview);
      ran.push(result.check);
      if (result.stops) stopped = { verdict: result.verdict, by: PREVIEW_CHECK_NAME };
    }
  }

  return { verdict: stopped?.verdict ?? "passed", checks: ran };
}

/** What running one thing produced, plus whether it ends the run. */
type Attempt =
  | { check: RanCheck; stops: false }
  | { check: RanCheck; stops: true; verdict: "failed" | "errored" };

async function runOne(
  sandbox: SandboxManager,
  sandboxId: string,
  check: DiscoveredCheck & { state: "runnable" },
): Promise<Attempt> {
  const result = await sandbox.exec(sandboxId, check.command);

  if (!result.ok) {
    // Absent, not failed: the command never produced an answer about the project. NapBench
    // makes the opposite call on the same event, and for a reason that does not apply here —
    // an absent check drops out of its weighting, so an unrunnable one could raise a score.
    // Nothing is being scored here, and the verdict below is what routes it.
    return {
      check: {
        name: check.name,
        outcome: "absent",
        detail: `could not run: ${result.error.code} — ${result.error.message}`,
      },
      stops: true,
      verdict: "errored",
    };
  }

  const { exitCode } = result.value;
  if (exitCode === 0) {
    return { check: { name: check.name, outcome: "passed", detail: "exit 0" }, stops: false };
  }

  const output = captureCommandOutput(result.value);

  return {
    check: {
      name: check.name,
      outcome: "failed",
      detail: `exit ${exitCode}`,
      // Only on a failure, and only when there was something to keep: a green build's output
      // is hundreds of lines that would crowd the failure out of a repair prompt.
      ...(output === undefined ? {} : { output }),
    },
    stops: true,
    verdict: "failed",
  };
}

async function probePreview(
  sandbox: SandboxManager,
  sandboxId: string,
  preview: { port: number; timeoutMs?: number },
): Promise<Attempt> {
  const diagnosis = await diagnosePreview(
    sandbox,
    sandboxId,
    preview.port,
    preview.timeoutMs === undefined ? {} : { timeoutMs: preview.timeoutMs },
  );

  if (diagnosis.state === "serving") {
    return {
      check: { name: PREVIEW_CHECK_NAME, outcome: "passed", detail: "serving" },
      stops: false,
    };
  }

  if (diagnosis.state === "not_started") {
    // The only preview answer that is the agent's: it built something that does not run.
    return {
      check: { name: PREVIEW_CHECK_NAME, outcome: "failed", detail: diagnosis.detail },
      stops: true,
      verdict: "failed",
    };
  }

  return {
    check: { name: PREVIEW_CHECK_NAME, outcome: "absent", detail: diagnosis.detail },
    stops: true,
    verdict: "errored",
  };
}

const notDeclared = (name: CheckName) => `the project declares no ${name} script`;

const notReached = (by: RanCheckName) => `not run: ${by} did not pass`;
