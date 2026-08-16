/**
 * The decisions the benchmark's command line makes, separated from the runs it performs.
 *
 * Written to the same shape as the runtime's harness, and for the same reason: one of these
 * decisions is whether real money is spent, and a rule that decides that must live somewhere a
 * test can drive it rather than inside a script where a mistake is only found by making it.
 * The script is the imperative shell — credentials, real components, files, output.
 *
 * **Unknown flags are refused rather than ignored.** `--rael` quietly meaning "dry run" is a
 * harmless surprise; the same forgiving parser lets `--budget-tokens` be mistyped on a run that
 * creates sandboxes and calls a model, and the default is then used silently.
 */

import type { Result } from "@nap/shared/result";
import { BENCHMARK_SUITE, type BenchSelection, SUITE_NAMES } from "./suite.ts";

/**
 * What a real run costs, capped up front.
 *
 * The cheap model and the low ceilings are deliberate, and the ceilings are higher than the
 * harness's because a benchmark task is real work rather than a wiring check — a to-do
 * application with a follow-up prompt does not fit in twelve model calls. All of it is
 * overridable for the day this is used to record something.
 */
export const NAPBENCH_DEFAULTS = {
  platform: "openrouter",
  model: "openai/gpt-5.6-luna",
  effort: "medium",
  maxOutputTokens: 16_384,
  /** Model calls in one turn. A generated application needs several files. */
  maxSteps: 40,
  budgetTokens: 120_000,
} as const;

export const NAPBENCH_USAGE = [
  "Usage: bun run napbench [options] <task-id>",
  "       bun run napbench [options] --suite=<name>",
  "       bun run napbench --baseline=<run-id|path> --candidate=<run-id|path>",
  "",
  `  --suite=<name>          Run a named suite, serially (${SUITE_NAMES.join(" | ")})`,
  "  --real                  Use real E2B, a real model and a real browser. Costs money.",
  `  --platform=<name>       openrouter | anthropic | bedrock (default ${NAPBENCH_DEFAULTS.platform}) — which account pays`,
  `  --model=<id>            Model for a real run (default ${NAPBENCH_DEFAULTS.model})`,
  `  --effort=<level>        low | medium | high | xhigh | max (default ${NAPBENCH_DEFAULTS.effort})`,
  `  --max-steps=<n>         Model calls allowed in a turn (default ${NAPBENCH_DEFAULTS.maxSteps})`,
  `  --budget-tokens=<n>     Context budget (default ${NAPBENCH_DEFAULTS.budgetTokens})`,
  "  --repeat=<n>            Run each task n times, reporting the spread (default 1). On a",
  "                          real run this multiplies the cost by n.",
  "  --keep                  Leave each sandbox running instead of destroying it",
  "",
  "  --baseline=<ref>        Compare two finished runs instead of running anything. Each",
  "  --candidate=<ref>       reference is a run id or a path to a report. Two runs, not three.",
  "",
  "Without --real it runs on a scripted model, an in-memory sandbox and a scripted browser:",
  "free, offline, and the scores mean nothing. It exercises the machinery, not a model.",
  "",
  `Example: bun run napbench --real --suite=${BENCHMARK_SUITE}`,
].join("\n");

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type BenchEffort = (typeof EFFORT_LEVELS)[number];

/** Where the models are reached from — the same three the harness offers, and the same order. */
const PLATFORMS = ["openrouter", "anthropic", "bedrock"] as const;
export type BenchPlatform = (typeof PLATFORMS)[number];

/**
 * A run of one task or one suite, and everything that decides what it costs.
 *
 * Every field here is meaningless to a comparison, which is why the two are separate members
 * of one union rather than one object with half its fields ignored in each mode.
 */
export type NapBenchRun = {
  kind: "run";
  selection: BenchSelection;
  /** False means fakes throughout: no network, no spend, and no meaning in the scores. */
  real: boolean;
  platform: BenchPlatform;
  model: string;
  effort: BenchEffort;
  maxSteps: number;
  budgetTokens: number;
  /**
   * How many times to run each selected task.
   *
   * One unless asked, because repeating multiplies what a real suite costs and that is a
   * decision somebody makes on purpose. Its reason for existing is that a single run is an
   * anecdote: two runs of one task under one configuration have already differed by fourteen
   * points here, so a comparison drawn from one run each is noise presented as a finding.
   */
  repeat: number;
  keep: boolean;
};

/**
 * Two runs to subtract, named by run id or by path.
 *
 * Two, and exactly two: comparing three runs is a table rather than a diff, and v1 says so.
 * Neither reference is resolved here — turning a run id into a file is the app's job, and this
 * package touches no filesystem.
 */
export type NapBenchCompare = {
  kind: "compare";
  baseline: string;
  candidate: string;
};

export type NapBenchCommand = NapBenchRun | NapBenchCompare;

/**
 * The flags that only mean something to a run.
 *
 * Named as a set so a comparison can refuse them by name. `--real` is the one that matters —
 * on a comparison it reads as "spend money on this", and it never would — but the same argument
 * covers the rest: a `--model` that silently does nothing is the sort of quiet that this parser
 * refuses everywhere else.
 */
const RUN_ONLY_FLAGS = [
  "suite",
  "real",
  "platform",
  "model",
  "effort",
  "max-steps",
  "budget-tokens",
  "repeat",
  "keep",
] as const;

const KNOWN_FLAGS = new Set<string>([...RUN_ONLY_FLAGS, "baseline", "candidate"]);

export function parseNapBenchArgs(argv: readonly string[]): Result<NapBenchCommand, string> {
  const flags = new Map<string, string>();
  const words: string[] = [];

  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      words.push(arg);
      continue;
    }
    const [name, value] = arg.slice(2).split("=");
    if (name === undefined || !KNOWN_FLAGS.has(name)) {
      return { ok: false, error: `unknown flag ${arg}` };
    }
    flags.set(name, value ?? "true");
  }

  if (flags.has("baseline") || flags.has("candidate")) {
    return parseComparison(words, flags);
  }

  const selection = resolveArguments(words, flags.get("suite"));
  if (!selection.ok) return selection;

  const effort = flags.get("effort") ?? NAPBENCH_DEFAULTS.effort;
  if (!isEffort(effort)) {
    return { ok: false, error: `effort must be one of ${EFFORT_LEVELS.join(", ")}` };
  }

  const platform = flags.get("platform") ?? NAPBENCH_DEFAULTS.platform;
  if (!isPlatform(platform)) {
    return { ok: false, error: `platform must be one of ${PLATFORMS.join(", ")}` };
  }

  const maxSteps = positiveInt(flags.get("max-steps"), NAPBENCH_DEFAULTS.maxSteps, "max-steps");
  if (!maxSteps.ok) return maxSteps;

  const budgetTokens = positiveInt(
    flags.get("budget-tokens"),
    NAPBENCH_DEFAULTS.budgetTokens,
    "budget-tokens",
  );
  if (!budgetTokens.ok) return budgetTokens;

  const repeat = positiveInt(flags.get("repeat"), 1, "repeat");
  if (!repeat.ok) return repeat;

  return {
    ok: true,
    value: {
      kind: "run",
      selection: selection.value,
      real: flags.has("real"),
      platform,
      model: flags.get("model") ?? NAPBENCH_DEFAULTS.model,
      effort,
      maxSteps: maxSteps.value,
      budgetTokens: budgetTokens.value,
      repeat: repeat.value,
      keep: flags.has("keep"),
    },
  };
}

/**
 * Reads the two references, and refuses a comparison mixed with anything else.
 *
 * A comparison reads two files that already exist: it starts nothing, creates nothing and
 * spends nothing. So a command line that asks for both a comparison and a run is asking for two
 * different things, and picking one would run something half the people who typed it did not
 * mean.
 */
function parseComparison(
  words: readonly string[],
  flags: ReadonlyMap<string, string>,
): Result<NapBenchCompare, string> {
  const baseline = flags.get("baseline");
  const candidate = flags.get("candidate");

  for (const [name, value] of [
    ["baseline", baseline],
    ["candidate", candidate],
  ] as const) {
    if (value === undefined) {
      return { ok: false, error: `--${name} is missing: a comparison needs both halves` };
    }
    // `--baseline` with no `=` parses as "true", which is not a run id and not a path.
    if (value === "true") {
      return { ok: false, error: `--${name} needs a run id or a path to a report` };
    }
  }
  if (baseline === undefined || candidate === undefined) {
    // Unreachable: the loop above returned for either. Written as a narrowing rather than a
    // check, because an error string here could never be observed failing.
    throw new Error("a missing half was not refused");
  }

  if (words.length > 0) {
    return {
      ok: false,
      error: `napbench either compares two reports or runs something, not both — drop ${words.join(", ")}`,
    };
  }

  const runOnly = RUN_ONLY_FLAGS.filter((name) => flags.has(name)).map((name) => `--${name}`);
  if (runOnly.length > 0) {
    return {
      ok: false,
      error: `${runOnly.join(", ")} ${runOnly.length === 1 ? "means" : "mean"} nothing to a comparison, which reads two reports and runs nothing`,
    };
  }

  return { ok: true, value: { kind: "compare", baseline, candidate } };
}

/**
 * Decides what was asked to run, and refuses anything ambiguous.
 *
 * Both a task and a suite is refused rather than resolved by precedence: whichever way a
 * precedence rule fell, half the people who hit it would have run something they did not ask
 * for, on a run that may have cost money.
 */
function resolveArguments(
  words: readonly string[],
  suite: string | undefined,
): Result<BenchSelection, string> {
  if (words.length > 1) {
    return { ok: false, error: `expected one task, got ${words.length}: ${words.join(", ")}` };
  }

  const taskId = words[0];

  if (taskId !== undefined) {
    if (suite !== undefined) return { ok: false, error: "give a task or a suite, not both" };
    return { ok: true, value: { kind: "task", taskId } };
  }

  if (suite === undefined) return { ok: false, error: "a task or a suite is required" };
  // `--suite` with no `=` parses as the string "true", which is nobody's suite name and is
  // worth naming as the mistake it is rather than reporting as an unknown suite.
  if (suite === "true") {
    return { ok: false, error: `--suite needs a name: ${SUITE_NAMES.join(", ")}` };
  }

  return { ok: true, value: { kind: "suite", suiteName: suite } };
}

function isEffort(value: string): value is BenchEffort {
  return (EFFORT_LEVELS as readonly string[]).includes(value);
}

function isPlatform(value: string): value is BenchPlatform {
  return (PLATFORMS as readonly string[]).includes(value);
}

function positiveInt(
  raw: string | undefined,
  fallback: number,
  name: string,
): Result<number, string> {
  if (raw === undefined) return { ok: true, value: fallback };

  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    return { ok: false, error: `${name} must be a positive whole number, got "${raw}"` };
  }
  return { ok: true, value: parsed };
}
