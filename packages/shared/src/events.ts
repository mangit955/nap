/**
 * The event contract (docs/PLAN.md §4 M0-3).
 *
 * `events` is the most load-bearing table in Nap — chat transcript, agent audit log,
 * WebSocket replay source, and v2's memory substrate, all one table (§5). Every producer
 * and consumer validates against this union, so the shape is defined exactly once here.
 *
 * Two rules govern the shapes below, both of them about surviving Postgres `jsonb`:
 *
 *   - **No `Date`, no `undefined`.** Timestamps are ISO-8601 strings and absent values are
 *     `null`. An event must satisfy `parse(JSON.parse(JSON.stringify(e)))` deep-equals `e`,
 *     and neither a `Date` nor a dropped `undefined` key does.
 *   - **Payloads are strict.** An unknown key is a bug in the producer, not something to
 *     silently drop on the way into the log.
 *
 * `sessionId` and `turnId` are validated as non-empty strings rather than UUIDs: docs/PLAN.md
 * §5 names the `id` columns but does not fix their format, and M0-5 owns that decision. It may
 * tighten this, and should.
 */

import { z } from "zod";

/** The six sandbox-proxy tools of docs/PLAN.md §4 M2-5. Nothing else may appear in the log. */
export const TOOL_NAMES = [
  "read_file",
  "write_file",
  "edit_file",
  "list_files",
  "search_files",
  "run_command",
] as const;

export const ToolNameSchema = z.enum(TOOL_NAMES);
export type ToolName = z.infer<typeof ToolNameSchema>;

/** Why a turn ended badly. One entry per failure mode M2-6/M2-7/M2-8 can produce. */
export const TurnFailureReasonSchema = z.enum([
  "refusal",
  "budget_exceeded",
  "cancelled",
  "sandbox_unavailable",
  "internal",
]);
export type TurnFailureReason = z.infer<typeof TurnFailureReasonSchema>;

/** Carried by every event, per docs/PLAN.md §4 M0-3. `seq` is assigned by `EventStore.append`. */
const envelope = {
  sessionId: z.string().min(1),
  turnId: z.string().min(1),
  seq: z.int().nonnegative(),
  createdAt: z.iso.datetime(),
};

/** Builds one union member, so the envelope is written once rather than eleven times. */
function event<const T extends string, S extends z.core.$ZodLooseShape>(type: T, payload: S) {
  return z.strictObject({
    ...envelope,
    type: z.literal(type),
    payload: z.strictObject(payload),
  });
}

const text = { text: z.string() };

const toolRef = {
  toolCallId: z.string().min(1),
  toolName: ToolNameSchema,
};

export const NapEventSchema = z.discriminatedUnion("type", [
  event("user.message", text),
  /** Summarized thinking — M2 runs the model with `display: "summarized"`. */
  event("agent.thinking", text),
  event("agent.message", text),
  event("tool.call", { ...toolRef, input: z.record(z.string(), z.unknown()) }),
  /** A tool failure sets `ok: false` and reports through `output`; it never throws. */
  event("tool.result", { ...toolRef, ok: z.boolean(), output: z.string() }),
  event("file.changed", {
    path: z.string().min(1),
    changeType: z.enum(["created", "modified", "deleted"]),
    /** Unified diff, produced by the write tools in M2-5. */
    diff: z.string(),
  }),
  /** One chunk of a `run_command` stream. Ordering is carried by `seq`, not by this event. */
  event("command.output", {
    toolCallId: z.string().min(1),
    stream: z.enum(["stdout", "stderr"]),
    chunk: z.string(),
  }),
  event("preview.ready", { url: z.url(), port: z.int().positive() }),
  event("turn.started", {}),
  event("turn.completed", {
    usage: z.strictObject({
      inputTokens: z.int().nonnegative(),
      outputTokens: z.int().nonnegative(),
    }),
    durationMs: z.int().nonnegative(),
    /** `null` when the turn changed no files, so there was nothing to commit. */
    commitSha: z.string().min(1).nullable(),
  }),
  event("turn.failed", { reason: TurnFailureReasonSchema, message: z.string() }),
]);

export type NapEvent = z.infer<typeof NapEventSchema>;

/** The 11 discriminator values, e.g. for exhaustive rendering in M3-4. */
export type NapEventType = NapEvent["type"];

/** Narrow `NapEvent` to a single member — `NapEventOf<"tool.call">`. */
export type NapEventOf<T extends NapEventType> = Extract<NapEvent, { type: T }>;
