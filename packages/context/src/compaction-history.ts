/**
 * The compaction history: the conversation that compaction summaries replaced, written out as
 * plain text the agent can search.
 *
 * A summary is lossy by design, and what it loses is exactly what an agent later needs and
 * cannot re-derive: the error text a command printed an hour ago, the approach that was tried
 * and dropped, the constraint stated once in passing. The event log still holds all of it, but
 * the agent cannot read the log, only the sandbox. So the runtime writes this rendering into
 * the sandbox and the summary cites entries in it.
 *
 * This module only renders; it performs no I/O. The text is a derived view of the log in the
 * sense of ADR-0008: the log stays the source of truth, nothing is ever edited into this file,
 * and it can be rebuilt from the events alone whenever a sandbox does not have it.
 *
 * Two properties are load-bearing, and the tests pin both:
 *
 * - **Identifiers are event numbers.** An entry is named by the `seq` of the event that began
 *   it, which the log never reassigns. A summary written today can cite `#42` and still be
 *   right after the file is regenerated in a different sandbox next week.
 * - **The file only grows.** Each API compaction checkpoint adds one part covering the events
 *   since the previous one, and the header says nothing that changes, so a later rendering
 *   always begins with the earlier one byte for byte.
 */

import { latestCheckpoint } from "@nap/shared/compaction";
import type { NapEvent } from "@nap/shared/events";

/**
 * Where the history lives in the sandbox.
 *
 * Under the sandbox user's home rather than the project: `/home/user/app` is committed every
 * turn, bundled into snapshots, served by the dev server and listed to the model and the Files
 * pane. A transcript there would be committed into the user's repository and shipped with
 * their app. Not `/tmp` either, which is the place a cleanup is entitled to empty. A dot
 * directory named for Nap, beside the desktop's `.nap-desktop`, is ours and nobody else's.
 */
export const COMPACTION_HISTORY_DIR = "/home/user/.nap/history";

/**
 * Bumped whenever the rendering changes, so a file written by an older version is regenerated
 * rather than trusted. The runtime records it beside the file.
 */
export const COMPACTION_HISTORY_FORMAT = 1;

/** One file per session: a project's sessions share a sandbox but not a conversation. */
export function compactionHistoryPath(sessionId: string): string {
  return `${COMPACTION_HISTORY_DIR}/${sessionId}.txt`;
}

/**
 * The event boundaries of every committed API compaction checkpoint, oldest first.
 *
 * Selected by the rule `latestCheckpoint` applies, so the last boundary here is always the one
 * the context engine rebuilds from: a part the agent is told about is a part the summary in
 * front of it actually replaced. Native markers add nothing. Their history belongs to the
 * native session, and the portable events they cover land in the next API part instead.
 */
export function compactionBoundaries(history: readonly NapEvent[]): number[] {
  const boundaries: number[] = [];
  for (let end = 1; end <= history.length; end++) {
    const event = history[end - 1];
    if (event?.type !== "compaction.completed" || event.payload.result.kind !== "api") continue;
    const covered = latestCheckpoint(history.slice(0, end))?.coveredThrough;
    if (covered !== undefined && covered > (boundaries.at(-1) ?? 0)) boundaries.push(covered);
  }
  return boundaries;
}

/**
 * The whole file: a fixed header, then one part per boundary.
 *
 * `boundaries` defaults to the log's committed checkpoints. A compaction passes its own new
 * boundary as well, because it writes the file before the event committing that boundary is
 * appended.
 */
export function renderCompactionHistory(
  history: readonly NapEvent[],
  sessionId: string,
  boundaries: readonly number[] = compactionBoundaries(history),
): string {
  let text = header(sessionId);
  let previous = 0;
  for (const [index, boundary] of boundaries.entries()) {
    const events = history.filter((event) => event.seq > previous && event.seq <= boundary);
    text += `\n==== Part ${index + 1}: events #${previous + 1} to #${boundary} ====\n\n`;
    text += renderHistoryEntries(events, { brief: false });
    previous = boundary;
  }
  return text;
}

function header(sessionId: string): string {
  return [
    `Nap compaction history for session ${sessionId}`,
    "",
    "The conversation that this session's compaction summaries replaced, written from its",
    "event log. Each compaction adds a part at the end; earlier parts never change.",
    'Every entry starts at the beginning of a line with its event number, as in "#42 user".',
    'Everything else is indented, so a search for "^#42 " finds exactly entry 42.',
    "",
  ].join("\n");
}

const BODY = "    ";
const NESTED = `${BODY}    `;

/**
 * The longest argument the brief form keeps. Enough for a path, a command or a search pattern,
 * far short of a file's contents.
 */
const BRIEF_ARGUMENT_CHARS = 128;

/**
 * Renders events as entries.
 *
 * `brief` is the form a summarizer reads: identical headers, so whatever it cites exists in
 * the file, but without the tool output and long arguments of every turn except the last. It
 * mirrors what the context engine's staleness pass drops from old turns (ADR-0011), which
 * keeps a summary call about as large as it was before the file existed. The summarizer can
 * cite what it cannot see, because the file has it under the same number.
 */
export function renderHistoryEntries(
  events: readonly NapEvent[],
  options: { brief: boolean },
): string {
  // The last turn anybody said anything in, which is the turn the context engine's staleness
  // pass spares too. Not simply the last turn: a `/compact`, or an app test about to take its
  // first step, has started and has no conversation yet, and counting it would hide the output
  // of the real last turn from the summary that is about to replace it.
  const lastTurn = events.findLast(isConversation)?.turnId;
  const lines: string[] = [];
  /** The event that opened the prose entry still being written, if the last entry was prose. */
  let prose: string | undefined;

  const entry = (event: NapEvent, title: string, body: string[] = []): void => {
    prose = undefined;
    lines.push(`#${event.seq} ${title}`, ...body);
  };
  const indent = (text: string, prefix = BODY): string[] =>
    text.split("\n").map((line) => `${prefix}${line}`);

  for (const event of events) {
    const stale = options.brief && event.turnId !== lastTurn;
    switch (event.type) {
      case "turn.started":
        entry(event, `turn ${event.turnId} started (${event.payload.source})`);
        break;
      case "user.message":
        entry(event, "user", [
          ...indent(event.payload.text),
          ...(event.payload.attachments ?? []).map(
            (attachment) => `${BODY}[reference: ${oneLine(attachment.name)} (${attachment.kind})]`,
          ),
        ]);
        break;
      case "agent.message": {
        // Prose reaches the log in the pieces it streamed in. One answer is one entry.
        if (prose !== undefined && prose === event.turnId) {
          const last = lines.length - 1;
          const [first = "", ...rest] = event.payload.text.split("\n");
          lines[last] += first;
          lines.push(...rest.map((line) => `${BODY}${line}`));
          break;
        }
        entry(event, "assistant", indent(event.payload.text));
        prose = event.turnId;
        break;
      }
      case "tool.call": {
        const { toolName, toolCallId, input } = event.payload;
        const body = Object.entries(input).flatMap(([rawKey, value]) => {
          const key = oneLine(rawKey);
          const text = typeof value === "string" ? value : JSON.stringify(value);
          if (stale && (text.includes("\n") || text.length > BRIEF_ARGUMENT_CHARS))
            return [`${BODY}${key}: [not repeated here; entry #${event.seq} has it in full]`];
          return text.includes("\n")
            ? [`${BODY}${key}:`, ...indent(text, NESTED)]
            : [`${BODY}${key}: ${text}`];
        });
        entry(event, `tool call ${toolName} (call ${oneLine(toolCallId)})`, body);
        break;
      }
      case "tool.result": {
        const { toolName, toolCallId, ok, output } = event.payload;
        entry(
          event,
          `tool result ${toolName} (call ${oneLine(toolCallId)})${ok ? "" : " failed"}`,
          stale
            ? [`${BODY}[output not repeated here; entry #${event.seq} has it in full]`]
            : indent(output),
        );
        break;
      }
      case "turn.completed":
        entry(event, "turn completed");
        break;
      case "turn.failed": {
        // A header is one line, whatever a failure message contains.
        const [first = "", ...rest] = event.payload.message.split("\n");
        entry(
          event,
          `turn failed (${event.payload.reason}): ${first}`,
          rest.map((line) => `${BODY}${line}`),
        );
        break;
      }
      case "compaction.completed":
        if (event.payload.result.kind === "api") entry(event, "context compacted");
        break;
      default:
        // Reasoning summaries, diffs, command streams, previews and notices exist to render
        // progress. None of them is something the model said or was told.
        break;
    }
  }
  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/** The event types that are something somebody said, which are what `toMessages` replays. */
function isConversation(event: NapEvent): boolean {
  return (
    event.type === "user.message" ||
    event.type === "agent.message" ||
    event.type === "tool.call" ||
    event.type === "tool.result"
  );
}

/**
 * A string from outside that has to stay on the line it was put on: a file name somebody
 * uploaded, a key or an id a model made up. Its next line would otherwise start at column 0,
 * where it could read as another entry's header. Quoted only when it has to be, since nearly
 * every name is an ordinary one and reads better bare.
 */
function oneLine(text: string): string {
  return text.includes("\n") ? JSON.stringify(text) : text;
}
