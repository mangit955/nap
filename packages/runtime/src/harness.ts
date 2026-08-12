/**
 * The decisions the CLI harness makes, separated from the run it performs.
 *
 * Argument parsing and event formatting are pure functions of their input, and one of them
 * decides whether a run spends money — so they live here, where they are typechecked and
 * tested, rather than inside a script where a mistake is only discovered by making it. The
 * script itself is the imperative shell: credentials, real components, output.
 */

import type { NapEvent } from "@nap/shared/events";
import type { Result } from "@nap/shared/result";

/**
 * What a real run costs, capped up front.
 *
 * The cheap model and the low ceilings are deliberate. A harness run proves the loop works end
 * to end, and a working loop is not more convincing for having been expensive; the model choice
 * changes nothing structural, since every model reached this way speaks the same blocks and the
 * same streaming events. All of it is overridable for the day this is used to record something —
 * `--model=<a stronger id>` is the whole difference.
 */
export const HARNESS_DEFAULTS = {
  platform: "openrouter",
  model: "openai/gpt-5.6-luna",
  effort: "medium",
  maxOutputTokens: 8_192,
  /** Model calls in one turn. A wiring check needing more than this has already failed. */
  maxSteps: 12,
  budgetTokens: 40_000,
} as const;

export const HARNESS_USAGE = [
  'Usage: bun run harness [options] "<prompt>"',
  "",
  "  --real                  Use real E2B and the real model. Costs money.",
  `  --platform=<name>       openrouter | anthropic | bedrock (default ${HARNESS_DEFAULTS.platform}) — which account pays`,
  `  --model=<id>            Model for a real run (default ${HARNESS_DEFAULTS.model})`,
  `  --effort=<level>        low | medium | high | xhigh | max (default ${HARNESS_DEFAULTS.effort})`,
  `  --max-steps=<n>         Model calls allowed in the turn (default ${HARNESS_DEFAULTS.maxSteps})`,
  `  --budget-tokens=<n>     Context budget (default ${HARNESS_DEFAULTS.budgetTokens})`,
  "  --keep                  Leave the sandbox running instead of destroying it",
  "",
  "Without --real it runs on a scripted model and an in-memory sandbox, and is free.",
].join("\n");

const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type HarnessEffort = (typeof EFFORT_LEVELS)[number];

/**
 * Where the models are reached from.
 *
 * All three speak the same Messages API and differ only in which account is billed and how the
 * client authenticates — see the notes in `@nap/agent`'s bedrock and openrouter modules.
 * OpenRouter is first because it is the one this project uses.
 */
const PLATFORMS = ["openrouter", "anthropic", "bedrock"] as const;
export type HarnessPlatform = (typeof PLATFORMS)[number];

export type HarnessOptions = {
  prompt: string;
  /** False means fakes throughout: no network, no spend. */
  real: boolean;
  platform: HarnessPlatform;
  model: string;
  effort: HarnessEffort;
  maxSteps: number;
  budgetTokens: number;
  keep: boolean;
};

/**
 * Reads the command line, or explains what was wrong with it.
 *
 * A typed failure rather than an exit, so the rule that decides whether real money is spent
 * is one a test can drive. Unknown flags are refused rather than ignored: `--rael` silently
 * meaning "dry run" is a harmless surprise, but the same forgiving parser would let
 * `--budget-tokens` be mistyped on a real run and quietly use the default.
 */
export function parseHarnessArgs(argv: readonly string[]): Result<HarnessOptions, string> {
  const known = new Set([
    "real",
    "platform",
    "model",
    "effort",
    "max-steps",
    "budget-tokens",
    "keep",
  ]);
  const flags = new Map<string, string>();
  const words: string[] = [];

  for (const arg of argv) {
    if (!arg.startsWith("--")) {
      words.push(arg);
      continue;
    }
    const [name, value] = arg.slice(2).split("=");
    if (name === undefined || !known.has(name)) return { ok: false, error: `unknown flag ${arg}` };
    flags.set(name, value ?? "true");
  }

  const prompt = words.join(" ").trim();
  if (prompt === "") return { ok: false, error: "a prompt is required" };

  const effort = flags.get("effort") ?? HARNESS_DEFAULTS.effort;
  if (!isEffort(effort)) {
    return { ok: false, error: `effort must be one of ${EFFORT_LEVELS.join(", ")}` };
  }

  const platform = flags.get("platform") ?? HARNESS_DEFAULTS.platform;
  if (!isPlatform(platform)) {
    return { ok: false, error: `platform must be one of ${PLATFORMS.join(", ")}` };
  }

  const maxSteps = positiveInt(flags.get("max-steps"), HARNESS_DEFAULTS.maxSteps, "max-steps");
  if (!maxSteps.ok) return maxSteps;

  const budgetTokens = positiveInt(
    flags.get("budget-tokens"),
    HARNESS_DEFAULTS.budgetTokens,
    "budget-tokens",
  );
  if (!budgetTokens.ok) return budgetTokens;

  return {
    ok: true,
    value: {
      prompt,
      real: flags.has("real"),
      platform,
      model: flags.get("model") ?? HARNESS_DEFAULTS.model,
      effort,
      maxSteps: maxSteps.value,
      budgetTokens: budgetTokens.value,
      keep: flags.has("keep"),
    },
  };
}

function isEffort(value: string): value is HarnessEffort {
  return (EFFORT_LEVELS as readonly string[]).includes(value);
}

function isPlatform(value: string): value is HarnessPlatform {
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

/** One line per event, so the ordering is what the reader sees first. */
export function formatEvent(event: NapEvent): string {
  const head = `${String(event.seq).padStart(3, " ")}  ${event.type.padEnd(15, " ")}`;
  return `${head} ${detail(event)}`.trimEnd();
}

function detail(event: NapEvent): string {
  switch (event.type) {
    case "user.message":
    case "agent.message":
    case "agent.thinking":
      return oneLine(event.payload.text);
    case "tool.call":
      return `${event.payload.toolName} ${oneLine(JSON.stringify(event.payload.input))}`;
    case "tool.result":
      return `${event.payload.toolName} ${event.payload.ok ? "ok" : "FAILED"} ${oneLine(event.payload.output)}`;
    case "file.changed":
      return `${event.payload.changeType} ${event.payload.path}`;
    case "command.output":
      return `${event.payload.stream} ${oneLine(event.payload.chunk)}`;
    case "preview.ready":
      return event.payload.url;
    case "preview.stopped":
      return "";
    case "turn.completed": {
      const { usage, durationMs, commitSha } = event.payload;
      return `${usage.inputTokens} in / ${usage.outputTokens} out, ${durationMs}ms, commit ${commitSha ?? "none"}`;
    }
    case "turn.failed":
      return `${event.payload.reason}: ${oneLine(event.payload.message)}`;
    case "system.notice":
      return `${event.payload.level}: ${oneLine(event.payload.text)}`;
    case "turn.started":
      return "";
  }
}

/** Events are for reading here, and a wall of file contents is not reading. */
export function oneLine(text: string, limit = 100): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= limit ? flat : `${flat.slice(0, limit - 1)}…`;
}
