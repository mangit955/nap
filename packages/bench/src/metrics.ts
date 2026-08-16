/**
 * How the agent got there, counted from the log it already wrote.
 *
 * Every figure here is derived from `NapEventSchema` and nothing else. Nap already keeps a
 * structured, durable, ordered record of everything a turn did, and a second instrumentation
 * path would be a source of truth that can disagree with the first — so the benchmark reads
 * the stream rather than asking production to report to it. No event was added to serve
 * evaluation, and none may be: see docs/adr/0003.
 *
 * **Three things the log cannot supply, and they stay absent.** Agent steps (the model loop
 * has no event marking its boundaries), retries (the provider retries inside itself and emits
 * nothing) and tokens on a *failed* turn (`turn.failed` carries a reason and a message, and no
 * usage). Each is typed optional and left off entirely rather than reported as zero, because a
 * zero is a measurement and these are absences — and because the day one of those events
 * exists for its own reasons, this model starts populating the field with no change to the
 * report schema and no invalidation of a single archived report.
 *
 * That is why the optional fields here are `undefined`-optional while the report elsewhere
 * insists on `null`: `null` is "we asked and there is nothing", and these are "this system
 * cannot answer at all". The first survives JSON as a value; the second is meant to vanish.
 */

import type { NapEvent, ToolName } from "@nap/shared/events";
import { z } from "zod";
import { CostEstimateSchema, estimateCost } from "./pricing.ts";

export const TokenUsageSchema = z.strictObject({
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
});

/**
 * How the turns inside a run ended. A run is one or more turns; see `CONTEXT.md`.
 *
 * Cancellation is counted apart from failure even though the log spells both `turn.failed`,
 * because a run somebody stopped is not an observation — the same distinction the run's own
 * status makes, and it would be lost if these were one number.
 */
export const TurnCountsSchema = z.strictObject({
  started: z.int().nonnegative(),
  completed: z.int().nonnegative(),
  failed: z.int().nonnegative(),
  cancelled: z.int().nonnegative(),
});

export const RunMetricsSchema = z.strictObject({
  /** Every `tool.call`, whatever the tool. */
  toolCalls: z.int().nonnegative(),
  /** `tool.result` with `ok: false` — the agent asking for something it could not have. */
  toolFailures: z.int().nonnegative(),
  /** The subset of tool calls that ran a command, which is the expensive kind. */
  commands: z.int().nonnegative(),
  /**
   * Distinct paths in `file.changed`, not the number of change events.
   *
   * An agent that edits one file eleven times touched one file; counting the events would
   * make thrashing look like breadth, which is the opposite of what it is.
   */
  filesChanged: z.int().nonnegative(),
  turns: TurnCountsSchema,

  /**
   * Tokens across the turns that completed.
   *
   * Absent when no turn completed — see ADR-0003. That is precisely the run where cost is
   * most worth knowing, and reporting zero there would understate a failing model's spend.
   */
  tokens: TokenUsageSchema.optional(),
  /**
   * The measured duration of the turns that completed, summed.
   *
   * Named for the turns rather than the run because it is not the run's wall clock: the
   * checks, the preview probe and the sandbox's own startup all happen outside it, and
   * `turn.failed` reports no duration at all. Absent for the same reason as `tokens`.
   */
  turnDurationMs: z.int().nonnegative().optional(),
  /** Derived, never measured. Absent whenever `tokens` or the model's price is. */
  estimatedCost: CostEstimateSchema.optional(),

  /**
   * Model calls in the run. **Never populated today**: a turn is several model calls and
   * nothing in the event contract marks the boundary, so the loop is invisible in the log.
   * Typed here so the day an `agent.step` event exists on its own merits, this fills in.
   */
  agentSteps: z.int().nonnegative().optional(),
  /**
   * Provider retries. **Never populated today**: `ClaudeProvider` retries inside itself and
   * emits nothing, so a turn that succeeded on the third attempt is indistinguishable from
   * one that succeeded first time.
   */
  retries: z.int().nonnegative().optional(),
});

export type TokenUsage = z.infer<typeof TokenUsageSchema>;
export type RunMetrics = z.infer<typeof RunMetricsSchema>;

/**
 * The one tool whose calls are commands, typed against the contract so a rename over there
 * fails here rather than silently zeroing the count.
 */
const RUN_COMMAND: ToolName = "run_command";

export type DeriveMetricsOptions = {
  /**
   * Which model ran, for pricing. Absent means the cost estimate is absent too.
   *
   * Not the same field as the report's `configuration.model`, and the duplication is
   * deliberate: this one exists to price what a run *consumed*, that one records what it was
   * *held at*. They carry the same value until the first run whose provider falls back
   * mid-way, which is precisely the run where collapsing them would make one of the two
   * readings wrong with nothing to say which.
   */
  model?: string | undefined;
};

/**
 * Counts a run's event stream.
 *
 * A single pass with an exhaustive-enough switch rather than one filter per figure: the
 * stream is the only input, and reading it once keeps every count derived from the same
 * events in the same order.
 */
export function deriveRunMetrics(
  events: readonly NapEvent[],
  options: DeriveMetricsOptions = {},
): RunMetrics {
  const paths = new Set<string>();
  let toolCalls = 0;
  let toolFailures = 0;
  let commands = 0;
  const turns = { started: 0, completed: 0, failed: 0, cancelled: 0 };

  // Accumulated separately from the counts, because "no turn completed" has to be
  // distinguishable from "the turns that completed used nothing".
  let usage: TokenUsage | undefined;
  let turnDurationMs: number | undefined;

  for (const event of events) {
    switch (event.type) {
      case "tool.call":
        toolCalls++;
        if (event.payload.toolName === RUN_COMMAND) commands++;
        break;
      case "tool.result":
        if (!event.payload.ok) toolFailures++;
        break;
      case "file.changed":
        paths.add(event.payload.path);
        break;
      case "turn.started":
        turns.started++;
        break;
      case "turn.completed":
        turns.completed++;
        usage = {
          inputTokens: (usage?.inputTokens ?? 0) + event.payload.usage.inputTokens,
          outputTokens: (usage?.outputTokens ?? 0) + event.payload.usage.outputTokens,
        };
        turnDurationMs = (turnDurationMs ?? 0) + event.payload.durationMs;
        break;
      case "turn.failed":
        if (event.payload.reason === "cancelled") turns.cancelled++;
        else turns.failed++;
        break;
      default:
        break;
    }
  }

  const estimated = estimateCost(options.model, usage);

  return {
    toolCalls,
    toolFailures,
    commands,
    filesChanged: paths.size,
    turns,
    // Spread rather than assigned, so an absent figure leaves no key at all. Written this
    // way because `{ tokens: undefined }` and `{}` differ once the object meets a strict
    // schema and a JSON round trip — and "absent" is the claim being made.
    ...optional("tokens", usage),
    ...optional("turnDurationMs", turnDurationMs),
    ...optional("estimatedCost", estimated),
  };
}

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
