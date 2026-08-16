/**
 * Asking the project whether the turn's claim is true.
 *
 * `turn.completed` is what the model says it did; this is what the system finds
 * (`docs/adr/0006`). Everything hard about running a check belongs to `@nap/verify` — which
 * checks a project has, what order is cheapest, where the run stops. What lives here is the
 * composition the runtime needs and the one decision `@nap/verify` cannot make for it: where
 * the manifest comes from.
 *
 * **The manifest is read from the project, and a manifest nobody can read runs nothing.** Not
 * "the project declares no checks" — that reading is an all-absent payload, which folds to
 * *verified*, and would checkpoint a commit against which nothing ran. A sandbox that will not
 * hand over its `package.json` is a sandbox that taught us nothing, which is what the
 * `errored` verdict is for.
 *
 * **The preview is a check.** Verification confined to sandbox commands and a preview probe is
 * ADR-0006's line, and the probe is the half that catches the application which compiles and
 * does not run. No browser: ADR-0001 keeps that in NapBench alone.
 */

import type { VerifiedCheck } from "@nap/shared/events";
import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import type { SandboxManager } from "@nap/shared/ports/sandbox-manager";
import type { CommandOutput } from "@nap/verify/command-output";
import { CHECK_NAMES, discoverChecks } from "@nap/verify/discover-checks";
import {
  PREVIEW_CHECK_NAME,
  type RanCheck,
  type RanCheckName,
  runChecks,
  type VerificationResult,
} from "@nap/verify/run-checks";

const MANIFEST_PATH = `${PROJECT_ROOT_PATH}/package.json`;

/** Every check a run could have produced, for the run that could not produce any. */
const EVERY_CHECK: readonly RanCheckName[] = [...CHECK_NAMES, PREVIEW_CHECK_NAME];

export type VerifyTurnOptions = {
  sandbox: SandboxManager;
  sandboxId: string;
  /** The port the project's dev server listens on — the same one the preview is announced at. */
  previewPort: number;
  /** How long to give the public preview URL before probing the port from inside. */
  previewTimeoutMs?: number;
};

export async function verifyTurn(options: VerifyTurnOptions): Promise<VerificationResult> {
  const { sandbox, sandboxId, previewPort } = options;

  const manifest = await sandbox.readFile(sandboxId, MANIFEST_PATH);
  if (!manifest.ok) {
    return unreadableManifest(`${manifest.error.code} — ${manifest.error.message}`);
  }

  return await runChecks(sandbox, sandboxId, discoverChecks(manifest.value), {
    preview: {
      port: previewPort,
      ...(options.previewTimeoutMs === undefined ? {} : { timeoutMs: options.previewTimeoutMs }),
    },
  });
}

/**
 * The whole run, unasked, because the question could not be put.
 *
 * Shaped like any other result rather than a separate failure type: its reader branches on the
 * verdict, and an errored run with its checks filled in is what lets a log line say which
 * checks were skipped and why without a second code path to produce that sentence.
 */
function unreadableManifest(reason: string): VerificationResult {
  const detail = `not run: the project's package.json could not be read (${reason})`;

  return {
    verdict: "errored",
    checks: EVERY_CHECK.map((name) => ({
      name,
      outcome: "absent" as const,
      detail,
    })),
  };
}

/**
 * A run's checks as the event log carries them.
 *
 * The log's shape is deliberately narrower than the runner's: `output` is one string or
 * nothing, because a client renders it and a repair prompt quotes it, and neither has any use
 * for a per-stream structure. Flattening it here rather than widening the event keeps the
 * contract in `events.ts` the only definition of what a reader will find.
 */
export function toVerifiedChecks(checks: readonly RanCheck[]): VerifiedCheck[] {
  return checks.map((check) => ({
    name: check.name,
    outcome: check.outcome,
    output: renderCheckOutput(check.output),
  }));
}

/**
 * Both streams, in the order a terminal would have shown them, each marked if it was cut.
 *
 * Stderr last on purpose: the reason a build failed is usually there, and the tail of this
 * string is the part a truncated prompt and a scrolled log both keep.
 *
 * Shared with the repair prompt rather than written twice, so what the log shows a person and
 * what the prompt shows the model are the same words. Already budgeted by whoever ran the
 * check — nothing here re-truncates it.
 */
export function renderCheckOutput(output: CommandOutput | undefined): string | null {
  if (output === undefined) return null;

  const rendered = [output.stdout, output.stderr]
    .filter((stream) => stream.text !== "")
    .map((stream) => (stream.truncated ? `…${stream.text}` : stream.text))
    .join("\n");

  return rendered === "" ? null : rendered;
}
