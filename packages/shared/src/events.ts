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
import { CheckOutcomeSchema } from "./check-outcome.ts";

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
  /**
   * The model could not be reached — throttled upstream, overloaded, or briefly down — and the
   * provider's retries were spent on it. Separate from `internal` because nothing here is
   * broken: the answer is to wait a moment and send the same message again, where `internal`
   * means this system did something wrong and the user can only try.
   */
  "model_unavailable",
  "internal",
]);
export type TurnFailureReason = z.infer<typeof TurnFailureReasonSchema>;

/**
 * How a job ended. Four ways, and the log says which rather than leaving it to be inferred.
 *
 * `unverified` is not a failure and not a success: a turn that answered a question changed no
 * files, so there was nothing to commit and nothing to check. Calling that `verified` would
 * claim the system had found something it never looked for.
 *
 * `abandoned` is the job ending because its turn did — cancelled, refused, or a sandbox that
 * went away. Distinct from `exhausted`, which is the loop running to the end of its rope with
 * checks still red; that one leaves committed code behind and a `HEAD` that has diverged from
 * the last checkpoint, and says so (docs/adr/0006).
 */
export const JobOutcomeSchema = z.enum(["verified", "unverified", "exhausted", "abandoned"]);
export type JobOutcome = z.infer<typeof JobOutcomeSchema>;

/**
 * Where a turn's prompt came from.
 *
 * A repair is a Turn like any other — same budgets, same cancellation, same ordering, same
 * commit-on-completion — and this is the one thing that distinguishes it (docs/adr/0006). It is
 * on `turn.started` rather than derived from position in the log, because deriving it would mean
 * counting verifications back from a turn and getting it wrong on every truncated window.
 */
export const PromptSourceSchema = z.enum(["user", "verification"]);
export type PromptSource = z.infer<typeof PromptSourceSchema>;

/**
 * One check as verification found it.
 *
 * `output` is what a failed check said, already budgeted by whoever ran it — this is a
 * transcript entry, not the place a cap is decided. `null` on a check that passed, was never
 * asked, or failed silently: a passing build's output is noise in a log somebody reads to find
 * out why something broke.
 */
export const VerifiedCheckSchema = z.strictObject({
  /** The check's name as the project knows it — `typecheck`, `lint`, `build`, `test`, `preview`. */
  name: z.string().min(1),
  outcome: CheckOutcomeSchema,
  output: z.string().nullable(),
});
export type VerifiedCheck = z.infer<typeof VerifiedCheckSchema>;

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
  /**
   * A turn opened, and who prompted it.
   *
   * Defaulted rather than required, and this is the only defaulted field in the contract: every
   * `turn.started` written before repairs existed has an empty payload, and a required field
   * would make replaying those sessions throw. A turn recorded before there was a verifier to
   * prompt one was prompted by a user, so the default states a fact rather than guessing.
   */
  event("turn.started", { source: PromptSourceSchema.default("user") }),
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

  /**
   * A job opened. Every turn belongs to one, and these five events are the whole of what a
   * job is: there is no jobs table and no `.nap/state.json`, only the fold in `job-state.ts`.
   *
   * `objective` repeats the prompt that opened the job, which is already in the log as a
   * `user.message`. The duplication is deliberate: it makes "what was asked" answerable from
   * the job events alone, without a reader having to work out which message belongs to which
   * job by counting turn boundaries — and a repair turn's `user.message` is not the objective.
   */
  event("job.started", { jobId: z.uuid(), objective: z.string().min(1) }),
  /**
   * Verification is running against the commit a turn just produced. Carries nothing but the
   * job: what is being checked is whatever the project declares, discovered rather than
   * announced, and the answer arrives in `verification.completed`.
   *
   * It exists so that "checks are running right now" is a fact in the log rather than a gap
   * between two events, which is what a client would otherwise have to render as nothing.
   */
  event("verification.started", { jobId: z.uuid() }),
  /**
   * What verification found. `failed` is not a field: a verification failed exactly when one
   * of its checks did, and recording the verdict beside the evidence invites the two to
   * disagree. Short-circuiting means the checks after the first failure are `absent`.
   */
  event("verification.completed", { jobId: z.uuid(), checks: z.array(VerifiedCheckSchema) }),
  /**
   * A commit that verification agreed with — a *checkpoint*, as against the commit every
   * completed turn makes. `HEAD == last checkpoint` is what "is this project in a valid state"
   * means, which is why the sha is here and not merely implied by the passing checks above it.
   */
  event("job.checkpointed", { jobId: z.uuid(), commitSha: z.string().min(1) }),
  /**
   * The job closed. The fold can derive most outcomes on its own, and does when a process died
   * before writing this — but "open" is the one thing about a job that must never be guessed,
   * because it is what decides whether opening the project spends tokens continuing it.
   */
  event("job.completed", { jobId: z.uuid(), outcome: JobOutcomeSchema }),
]);

export type NapEvent = z.infer<typeof NapEventSchema>;

/** Every discriminator value — the exhaustiveness source for anything rendering a stream. */
export type NapEventType = NapEvent["type"];

/** Narrow `NapEvent` to a single member — `NapEventOf<"tool.call">`. */
export type NapEventOf<T extends NapEventType> = Extract<NapEvent, { type: T }>;
