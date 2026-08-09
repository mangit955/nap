/**
 * Turning an event log into the things a reader sees.
 *
 * The log is a flat, ordered stream of eleven event types; a transcript is a much shorter list
 * of blocks, because a tool call, everything it printed, the files it touched and how it ended
 * are one thing on screen and four kinds of event in the log. This fold is where that
 * difference lives, and keeping it a pure function is what lets the interesting cases —
 * interleaved tool calls, a stream still arriving — be tested without rendering anything.
 *
 * Two rules do most of the work:
 *
 *   - **A result belongs to the call with its `toolCallId`, never to whichever step is last.**
 *     Tools can be answered out of order, and attributing a failure to the wrong step tells the
 *     user the wrong command broke.
 *   - **`file.changed` attaches to the step that is still open.** It carries no `toolCallId`,
 *     and the only reason it does not need one is that the tools emit it between a call and its
 *     result (`packages/agent/src/tools/execute.ts`). Outside a step it stands alone rather than
 *     being dropped — losing it would lose the only record that a file changed.
 *
 * The whole event list is re-folded on every frame, since that is what the stream hook hands
 * back, so output accumulates by appending to the item being built rather than by mutating
 * anything that survives the call.
 */

import type { NapEventOf, ToolName } from "@nap/shared/events";
import type { StoredEvent } from "@nap/shared/ports/event-store";

export type FileChange = {
  path: string;
  changeType: NapEventOf<"file.changed">["payload"]["changeType"];
  diff: string;
  added: number;
  removed: number;
};

export type StepStatus = "running" | "ok" | "failed";

export type TranscriptItem =
  | { kind: "message"; key: number; from: "user" | "agent"; text: string }
  | { kind: "thinking"; key: number; text: string }
  | {
      kind: "step";
      key: number;
      toolCallId: string;
      toolName: ToolName;
      input: Record<string, unknown>;
      status: StepStatus;
      /** What the tool told the model. Empty until the result arrives. */
      output: string;
      /** Everything `run_command` printed, in the order it printed it. */
      streamed: string;
      hasStderr: boolean;
      files: FileChange[];
    }
  | { kind: "files"; key: number; files: FileChange[] }
  | { kind: "preview"; key: number; url: string; port: number }
  | { kind: "turn-start"; key: number }
  | ({ kind: "turn-end"; key: number } & TurnOutcome);

type TurnOutcome =
  | {
      outcome: "completed";
      durationMs: number;
      inputTokens: number;
      outputTokens: number;
      commitSha: string | null;
    }
  | { outcome: "failed"; reason: NapEventOf<"turn.failed">["payload"]["reason"]; message: string };

type Step = Extract<TranscriptItem, { kind: "step" }>;

export function buildTranscript(events: readonly StoredEvent[]): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const stepsById = new Map<string, Step>();
  // The step a `file.changed` belongs to: the last one opened that has not been answered yet.
  let openStep: Step | undefined;

  for (const event of events) {
    // `seq` is unique per session and never reused, so it is a stable React key for free —
    // an index would re-key the whole list on every new event, springing collapsed steps open.
    const key = event.seq;

    switch (event.type) {
      case "user.message":
        items.push({ kind: "message", key, from: "user", text: event.payload.text });
        break;

      case "agent.message":
        items.push({ kind: "message", key, from: "agent", text: event.payload.text });
        break;

      case "agent.thinking":
        items.push({ kind: "thinking", key, text: event.payload.text });
        break;

      case "tool.call": {
        const step: Step = {
          kind: "step",
          key,
          toolCallId: event.payload.toolCallId,
          toolName: event.payload.toolName,
          input: event.payload.input,
          status: "running",
          output: "",
          streamed: "",
          hasStderr: false,
          files: [],
        };
        stepsById.set(step.toolCallId, step);
        openStep = step;
        items.push(step);
        break;
      }

      case "tool.result": {
        // A client that reconnected between a call and its result holds the second without
        // the first. Opening a step here is what keeps that tool visible at all — dropping it
        // would hide a failure from the one person who needs to see it.
        const step =
          stepsById.get(event.payload.toolCallId) ??
          openOrphan(event.payload.toolCallId, event.payload.toolName, key, items, stepsById);
        step.status = event.payload.ok ? "ok" : "failed";
        step.output = event.payload.output;
        if (openStep === step) openStep = undefined;
        break;
      }

      case "command.output": {
        // Same reconnection case. `run_command` is the only tool that streams, so a chunk
        // whose call is missing can be attributed without guessing.
        const step =
          stepsById.get(event.payload.toolCallId) ??
          openOrphan(event.payload.toolCallId, "run_command", key, items, stepsById);
        step.streamed += event.payload.chunk;
        if (event.payload.stream === "stderr") step.hasStderr = true;
        break;
      }

      case "file.changed": {
        const change = toFileChange(event.payload);
        if (openStep === undefined) items.push({ kind: "files", key, files: [change] });
        else openStep.files.push(change);
        break;
      }

      case "preview.ready":
        items.push({ kind: "preview", key, url: event.payload.url, port: event.payload.port });
        break;

      case "turn.started":
        items.push({ kind: "turn-start", key });
        break;

      case "turn.completed":
        items.push({
          kind: "turn-end",
          key,
          outcome: "completed",
          durationMs: event.payload.durationMs,
          inputTokens: event.payload.usage.inputTokens,
          outputTokens: event.payload.usage.outputTokens,
          commitSha: event.payload.commitSha,
        });
        break;

      case "turn.failed":
        items.push({
          kind: "turn-end",
          key,
          outcome: "failed",
          reason: event.payload.reason,
          message: event.payload.message,
        });
        break;
    }
  }

  return items;
}

/**
 * A step for a tool whose `tool.call` this client never received, which happens when it
 * connected partway through the tool's execution. `input` is empty because it is genuinely
 * unknown — the alternative is inventing arguments the tool was never given.
 */
function openOrphan(
  toolCallId: string,
  toolName: ToolName,
  key: number,
  items: TranscriptItem[],
  stepsById: Map<string, Step>,
): Step {
  const step: Step = {
    kind: "step",
    key,
    toolCallId,
    toolName,
    input: {},
    status: "running",
    output: "",
    streamed: "",
    hasStderr: false,
    files: [],
  };
  stepsById.set(toolCallId, step);
  items.push(step);
  return step;
}

function toFileChange(payload: NapEventOf<"file.changed">["payload"]): FileChange {
  let added = 0;
  let removed = 0;

  for (const line of payload.diff.split("\n")) {
    // `+++`/`---` are the file headers of a unified diff, not changed lines.
    if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }

  return { path: payload.path, changeType: payload.changeType, diff: payload.diff, added, removed };
}
