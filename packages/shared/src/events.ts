/**
 * The event contract.
 *
 * `events` is the most load-bearing table in Nap — chat transcript, agent audit log,
 * WebSocket replay source, and v2's memory substrate, all one table (docs/PLAN.md §5).
 * Every producer and consumer validates against this union, so the shape is defined
 * exactly once here.
 *
 * Two rules govern the shapes below, both of them about surviving Postgres `jsonb`:
 *
 *   - **No `Date`, no `undefined`.** Timestamps are ISO-8601 strings and absent values are
 *     `null`. An event must satisfy `parse(JSON.parse(JSON.stringify(e)))` deep-equals `e`,
 *     and neither a `Date` nor a dropped `undefined` key does.
 *   - **Payloads are strict.** An unknown key is a bug in the producer, not something to
 *     silently drop on the way into the log.
 *
 * `sessionId` and `turnId` are UUIDs, matching the `uuid` primary keys the database schema
 * uses. Validating the format here means a malformed id is caught at the boundary rather
 * than by Postgres several layers later.
 */

import { z } from "zod";

/** The six sandbox-proxy tools. Nothing else may appear in the log. */
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

/** Why a turn ended badly. One entry per failure mode the runtime can produce. */
export const TurnFailureReasonSchema = z.enum([
  "refusal",
  "budget_exceeded",
  "cancelled",
  "sandbox_unavailable",
  "internal",
]);
export type TurnFailureReason = z.infer<typeof TurnFailureReasonSchema>;

/** Carried by every event. `seq` is assigned by `EventStore.append`, not by the emitter. */
const envelope = {
  sessionId: z.uuid(),
  turnId: z.uuid(),
  seq: z.int().nonnegative(),
  createdAt: z.iso.datetime(),
};

/** Builds one union member, so the envelope is written once rather than once per type. */
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
  /** Summarized reasoning, not raw thinking — the model is run with `display: "summarized"`. */
  event("agent.thinking", text),
  event("agent.message", text),
  event("tool.call", { ...toolRef, input: z.record(z.string(), z.unknown()) }),
  /** A tool failure sets `ok: false` and reports through `output`; it never throws. */
  event("tool.result", { ...toolRef, ok: z.boolean(), output: z.string() }),
  event("file.changed", {
    path: z.string().min(1),
    changeType: z.enum(["created", "modified", "deleted"]),
    /** Unified diff, produced by the write tools. */
    diff: z.string(),
  }),
  /** One chunk of a `run_command` stream. Ordering is carried by `seq`, not by this event. */
  event("command.output", {
    toolCallId: z.string().min(1),
    stream: z.enum(["stdout", "stderr"]),
    chunk: z.string(),
  }),
  event("preview.ready", { url: z.url(), port: z.int().positive() }),
  /**
   * The sandbox serving this project has been destroyed, so the address the last
   * `preview.ready` announced no longer answers.
   *
   * It exists because a client cannot work this out for itself. A preview is put away by a
   * sweep on a timer or by someone in another tab, and without a record of it in the log the
   * pane keeps an iframe pointed at a host that has stopped existing — which renders as the
   * provider's own "not found" page inside a frame that otherwise looks like a working app.
   * Nothing in the payload: which sandbox went away is not something a viewer can act on, and
   * the address it replaces is already in the log above this.
   */
  event("preview.stopped", {}),
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
  /**
   * Something the system did that the user should know about, said in its own voice.
   *
   * Deliberately not an `agent.message`: every one of those is something the model actually
   * said, and a client renders it as such. The cases this exists for — a snapshot that could
   * not be restored, so the project came up empty — are the platform explaining itself, and
   * attributing them to the model would be a lie about who is talking.
   */
  event("system.notice", { level: z.enum(["info", "warning"]), text: z.string().min(1) }),
]);

export type NapEvent = z.infer<typeof NapEventSchema>;

/** Every discriminator value — the exhaustiveness source for anything rendering a stream. */
export type NapEventType = NapEvent["type"];

/** Narrow `NapEvent` to a single member — `NapEventOf<"tool.call">`. */
export type NapEventOf<T extends NapEventType> = Extract<NapEvent, { type: T }>;
