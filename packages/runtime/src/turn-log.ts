/**
 * What one event looks like as a log line.
 *
 * The goal is that grepping a `turnId` reconstructs the turn: which tools ran, in what order,
 * which one failed, what changed, how it ended and what it cost. That is a *shape*, not a
 * transcript, and the distinction is deliberate.
 *
 * **No content is copied here — no message text, no diffs, no command output.** All of it is
 * already in the `events` table, addressable by the very ids these lines carry, and that table
 * is the audit log by design (docs/PLAN.md §5). Logs are a second home with a different
 * retention, a different destination and different readers, and putting a user's private
 * project through it a second time buys nothing that following the ids into the log does not.
 * Sizes are reported instead, which is enough to tell "the model said nothing" from "the model
 * wrote three paragraphs".
 *
 * `seq` is on every line because it is what puts a turn back in order. Log timestamps are
 * per-line, and two events appended in the same millisecond sort arbitrarily by them.
 */

import type { NapEvent } from "@nap/shared/events";
import type { StoredEvent } from "@nap/shared/ports/event-store";

export type EventLogLine = {
  level: "debug" | "info" | "warn";
  fields: Record<string, unknown>;
};

export function eventLogLine(event: StoredEvent): EventLogLine {
  return {
    level: levelFor(event),
    fields: { eventType: event.type, seq: event.seq, ...detail(event) },
  };
}

function levelFor(event: StoredEvent): EventLogLine["level"] {
  // A build prints thousands of lines and each one is its own event. At info they would bury
  // the turn they belong to, and the `tool.result` that follows already reports the outcome.
  if (event.type === "command.output") return "debug";

  // Levels are how anyone looks for trouble without knowing what they are looking for. A
  // failed turn and a warning notice logged at info are invisible to that, and the two things
  // a rate of failures is measured from.
  if (event.type === "turn.failed") return "warn";
  if (event.type === "system.notice") return event.payload.level === "warning" ? "warn" : "info";

  // A job that spent all three repairs with checks still red is the failure this whole loop
  // exists to prevent, and it leaves committed code behind that nobody has verified. The other
  // three outcomes are ordinary; only this one is worth finding without knowing to look.
  if (event.type === "job.completed" && event.payload.outcome === "exhausted") return "warn";

  return "info";
}

/**
 * The identifying half of a payload, per type.
 *
 * A `switch` over the discriminator rather than a lookup table, because that is what makes a
 * new event type a compile error here instead of a line that logs only its name.
 */
function detail(event: NapEvent): Record<string, unknown> {
  switch (event.type) {
    case "user.message":
    case "agent.message":
    case "agent.thinking":
      return { chars: event.payload.text.length };

    case "tool.call":
      return { toolName: event.payload.toolName, toolCallId: event.payload.toolCallId };

    case "tool.result":
      return {
        toolName: event.payload.toolName,
        toolCallId: event.payload.toolCallId,
        ok: event.payload.ok,
        chars: event.payload.output.length,
      };

    case "file.changed":
      // The path is not content: it is what the turn did, and the whole point of the line.
      return { path: event.payload.path, changeType: event.payload.changeType };

    case "command.output":
      return {
        toolCallId: event.payload.toolCallId,
        stream: event.payload.stream,
        chars: event.payload.chunk.length,
      };

    case "preview.ready":
      // The URL is a public address for the user's running app, so only the port is logged.
      return { port: event.payload.port };

    case "preview.stopped":
      return {};

    case "turn.started":
      return {};

    case "turn.completed":
      return {
        durationMs: event.payload.durationMs,
        inputTokens: event.payload.usage.inputTokens,
        outputTokens: event.payload.usage.outputTokens,
        commitSha: event.payload.commitSha,
      };

    case "turn.failed":
      // The reason, not the message: the reason is the enum you alert on, and the message is
      // free text that can quote the model or the user.
      return { reason: event.payload.reason };

    case "system.notice":
      return { noticeLevel: event.payload.level };

    case "job.started":
      // The objective is the user's own prose, and the rule above applies to it as much as to
      // a message: it is in the `events` table already, addressable by this very id.
      return { jobId: event.payload.jobId, chars: event.payload.objective.length };

    case "verification.started":
      return { jobId: event.payload.jobId };

    case "verification.completed":
      // The outcomes, not the output. Which check went red is what a rate of repair loops is
      // measured from; what it said is a diagnostic, and it is in the log under this `seq`.
      return {
        jobId: event.payload.jobId,
        checks: Object.fromEntries(event.payload.checks.map((c) => [c.name, c.outcome])),
      };

    case "job.checkpointed":
      return { jobId: event.payload.jobId, commitSha: event.payload.commitSha };

    case "job.completed":
      return { jobId: event.payload.jobId, outcome: event.payload.outcome };
  }
}
