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
 * **Three verdicts, because one of them is not the project's fault.** `failed` means a check the
 * project asked for said no — that is a repair turn. `errored` means the run learned nothing:
 * the sandbox refused the command, or the preview is listening but unreachable from out here.
 * Opening a repair turn on either would spend tokens asking a model to fix a machine it cannot
 * see, so the checks involved come back *absent*. Same reading as `diagnosePreview`, and the
 * same one `CheckOutcome` was given three values for.
 *
 * **`errored` is not a verification, and must never be recorded as one.** This is the sharp
 * edge on this module. `verification.completed` carries checks and no verdict on purpose — a
 * verification failed exactly when one of its checks did — and `foldJobs` reads an all-absent
 * payload as `verified`, correctly, because an unasked check is not a failed one. So a caller
 * that emitted the event for an errored run would tell the log that a commit nothing ran
 * against had been checked, and `job.checkpointed` would follow. An errored run is the job
 * ending as **abandoned**: the sandbox went away, which `JobOutcome` already has a word for.
 * The verdict exists to be branched on before anything is written, not to be persisted.
 */

import type { CheckOutcome } from "@nap/shared/check-outcome";
import type { SandboxManager } from "@nap/shared/ports/sandbox-manager";
import { type CommandOutput, captureCommandOutput } from "./command-output.ts";
import type { CheckName, DiscoveredCheck } from "./discover-checks.ts";
import { type DiagnosePreviewOptions, diagnosePreview } from "./preview.ts";

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

/** Which port to probe, and how long to give it — `diagnosePreview`'s two questions. */
export type PreviewProbe = { port: number } & DiagnosePreviewOptions;

export type RunChecksOptions = {
  /**
   * The preview probe, when the project serves something. Omitted for a project that does not,
   * rather than defaulted to a port — a check nobody asked for must not be able to fail.
   */
  preview?: PreviewProbe;
};

export async function runChecks(
  sandbox: SandboxManager,
  sandboxId: string,
  checks: readonly DiscoveredCheck[],
  options: RunChecksOptions = {},
): Promise<VerificationResult> {
  const ran: RanCheck[] = [];
  /** What ended the run, once something has. Everything after it is recorded unasked. */
  let stopped: Stop | undefined;

  for (const check of checks) {
    if (check.state === "absent") {
      ran.push({ name: check.name, outcome: "absent", detail: notDeclared(check.name) });
      continue;
    }

    if (stopped !== undefined) {
      ran.push({ name: check.name, outcome: "absent", detail: notReached(stopped) });
      continue;
    }

    const attempt = await runOne(sandbox, sandboxId, check);
    ran.push(attempt.check);
    stopped = attempt.stopped;
  }

  if (options.preview !== undefined) {
    if (stopped !== undefined) {
      ran.push({ name: PREVIEW_CHECK_NAME, outcome: "absent", detail: notReached(stopped) });
    } else {
      const attempt = await probePreview(sandbox, sandboxId, options.preview);
      ran.push(attempt.check);
      stopped = attempt.stopped;
    }
  }

  return { verdict: stopped?.verdict ?? "passed", checks: ran };
}

/**
 * Why the run ended early, kept whole so the checks after it can say which of the two it was.
 *
 * The distinction is the same one `detail` exists for on an unasked check: "there is no lint
 * script", "lint was never reached because typecheck failed" and "lint was never reached
 * because the sandbox was gone" are one outcome and three different things to do about it.
 */
type Stop = { verdict: "failed" | "errored"; by: RanCheckName };

/** What running one thing produced, and what — if anything — it ends. */
type Attempt = { check: RanCheck; stopped: Stop | undefined };

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
      stopped: { verdict: "errored", by: check.name },
    };
  }

  const { exitCode } = result.value;
  if (exitCode === 0) {
    return {
      check: { name: check.name, outcome: "passed", detail: "exit 0" },
      stopped: undefined,
    };
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
    stopped: { verdict: "failed", by: check.name },
  };
}

async function probePreview(
  sandbox: SandboxManager,
  sandboxId: string,
  preview: PreviewProbe,
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
      stopped: undefined,
    };
  }

  if (diagnosis.state === "not_started") {
    // The only preview answer that is the agent's: it built something that does not run.
    return {
      check: { name: PREVIEW_CHECK_NAME, outcome: "failed", detail: diagnosis.detail },
      stopped: { verdict: "failed", by: PREVIEW_CHECK_NAME },
    };
  }

  return {
    check: { name: PREVIEW_CHECK_NAME, outcome: "absent", detail: diagnosis.detail },
    stopped: { verdict: "errored", by: PREVIEW_CHECK_NAME },
  };
}

const notDeclared = (name: CheckName) => `the project declares no ${name} script`;

const notReached = (stop: Stop) =>
  stop.verdict === "failed"
    ? `not run: ${stop.by} failed first`
    : `not run: ${stop.by} could not be run`;
