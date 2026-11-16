/**
 * The command line of `scripts/harbor-task.ts`, the entrypoint Harbor's Python agent starts.
 *
 * Here rather than in the script so the rule that decides whether money is spent is one a test can
 * drive: a model that is not free is refused unless `--spend` says otherwise. A benchmark run on a
 * free model's daily quota that ran out would otherwise be one mistyped `--model` away from a bill.
 */

import { isFreeModel } from "@nap/shared/model-capabilities";
import type { Result } from "@nap/shared/result";

export const HARBOR_TASK_DEFAULTS = {
  /**
   * Model calls one task may make. Terminal-Bench gives a task's agent between 750 and 3,600
   * seconds, which a turn of this many steps fits, and a free model's quota is counted in
   * requests: each step is at least one, and up to three when the provider retries it.
   */
  maxSteps: 20,
  maxOutputTokens: 8_192,
  effort: "medium",
} as const;

/**
 * What the entrypoint reads from and writes to the job directory. `harbor/nap_harbor/trial.py`
 * names the same files; `harbor-task-args.test.ts` reads it to keep the two in step.
 */
export const HARBOR_TASK_FILES = {
  instruction: "instruction.md",
  result: "nap-result.json",
  trajectory: "trajectory.jsonl",
} as const;

export type HarborTaskOptions = {
  /** Harbor's directory for this trial's agent: the instruction is read from it, results go to it. */
  jobDir: string;
  model: string;
  maxSteps: number;
  spend: boolean;
};

export const HARBOR_TASK_USAGE = [
  "Usage: bun run packages/runtime/scripts/harbor-task.ts --job-dir=<dir> --model=<id> [options]",
  "",
  `  --max-steps=<n>   Model calls allowed in the turn (default ${HARBOR_TASK_DEFAULTS.maxSteps}); each is up to 3 requests`,
  "  --spend           Allow a model that is not free (an OpenRouter id without `:free`)",
  "",
  "Started by harbor/nap_harbor/agent.py, which answers its commands on stdin; see harbor/README.md.",
].join("\n");

export function parseHarborTaskArgs(argv: readonly string[]): Result<HarborTaskOptions, string> {
  const known = new Set(["job-dir", "model", "max-steps", "spend"]);
  const flags = new Map<string, string>();
  for (const arg of argv) {
    if (!arg.startsWith("--")) return { ok: false, error: `unexpected argument ${arg}` };
    const separator = arg.indexOf("=");
    const name = separator === -1 ? arg.slice(2) : arg.slice(2, separator);
    if (!known.has(name)) return { ok: false, error: `unknown flag ${arg}` };
    flags.set(name, separator === -1 ? "true" : arg.slice(separator + 1));
  }

  const jobDir = flags.get("job-dir");
  if (jobDir === undefined || jobDir === "" || jobDir === "true")
    return { ok: false, error: "--job-dir is required" };
  const model = flags.get("model");
  if (model === undefined || model === "" || model === "true")
    return { ok: false, error: "--model is required" };

  const spend = flags.get("spend") === "true";
  if (!spend && !isFreeModel(model))
    return {
      ok: false,
      error: `${model} is not a free model; pass --spend to run it, which costs money`,
    };

  const rawSteps = flags.get("max-steps");
  const maxSteps = rawSteps === undefined ? HARBOR_TASK_DEFAULTS.maxSteps : Number(rawSteps);
  if (!Number.isSafeInteger(maxSteps) || maxSteps <= 0)
    return { ok: false, error: `max-steps must be a positive whole number, got "${rawSteps}"` };

  return { ok: true, value: { jobDir, model, maxSteps, spend } };
}
