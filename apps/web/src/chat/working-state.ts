/**
 * What the agent is doing right now, said in a sentence.
 *
 * A turn is bursts of tool calls separated by silences of ten or twenty seconds, and during a
 * silence the transcript is a static list of things that already finished. So the running
 * indicator carries a label, and the label is derived from the same fold everything else on the
 * rail is drawn from — there is no second source of truth about what is happening, because a
 * second one would eventually disagree with the steps printed directly above it.
 *
 * Pure, and in a `.ts` beside `transcript.ts` for the same reason that one is: the interesting
 * cases are parallel calls and a log that begins mid-turn, and neither needs a DOM to test.
 */

import type { ToolName } from "@nap/shared/events";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import type { TranscriptItem } from "./transcript.ts";

type Step = Extract<TranscriptItem, { kind: "step" }>;

/**
 * Present participles, because this label is read as a sentence.
 *
 * Deliberately not the `VERBS` map in `tool-step.tsx`: those are terse ("read", "write")
 * because they are read vertically down a column of steps, and the two want different words
 * for the same reason a heading and a caption do.
 */
const DOING: Record<ToolName, string> = {
  read_file: "Reading",
  write_file: "Writing",
  edit_file: "Editing",
  list_files: "Listing",
  search_files: "Searching for",
  run_command: "Running",
};

/** Paths are absolute in the sandbox; the project root is noise in every single line. */
export function shorten(value: string): string {
  return value.replace("/home/user/app/", "");
}

/**
 * The one argument that says which call this is. A step's identity is its target, not its
 * full arguments — those are available by expanding it.
 *
 * Lives here rather than in `tool-step.tsx` so both the step line and the running label read
 * a call the same way. Two copies of this would drift, and the way they would drift is one
 * surface stripping the sandbox prefix while the other prints it.
 */
export function stepTarget(step: Step): string {
  const { command, path, pattern } = step.input as {
    command?: unknown;
    path?: unknown;
    pattern?: unknown;
  };

  for (const value of [command, pattern, path]) {
    if (typeof value === "string" && value !== "") return shorten(value);
  }
  return "";
}

/**
 * A file path shown to somebody watching a label change every few seconds is a filename. The
 * directory is in the step line above and adds nothing here except width.
 */
function leaf(target: string): string {
  const parts = target.split("/");
  return parts[parts.length - 1] ?? target;
}

/**
 * What to call the work in flight.
 *
 * The *last* open call wins, not the first. Parallel tool use is on by default, so one
 * assistant message can open several calls at once; naming the earliest would leave the label
 * describing a call that has already come back while a later one is still out.
 */
export function workingLabel(items: readonly TranscriptItem[]): string {
  let turnOpen = false;

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index];
    if (item === undefined) continue;

    if (item.kind === "step" && item.status === "running") {
      const target = stepTarget(item);
      // A step whose arguments this client never received — it connected between the call and
      // its result. The verb alone is honest; inventing a target would not be.
      if (target === "") return DOING[item.toolName];
      return `${DOING[item.toolName]} ${item.toolName === "run_command" ? target : leaf(target)}`;
    }

    if (item.kind === "turn-start") {
      turnOpen = true;
      break;
    }
  }

  // Between calls the model is generating, which is the longest silence in a turn and the one
  // most in need of something on screen. Before the turn has even been acknowledged there is
  // nothing to describe, and saying "thinking" then would be a guess about a server that has
  // not answered yet.
  return turnOpen ? "Thinking" : "Starting up";
}

/**
 * When the open turn started, as the server timestamped it.
 *
 * The elapsed clock is anchored here rather than to the moment the indicator mounted, so a
 * reload in the middle of a turn resumes the count instead of restarting it — and so the
 * number hands over to the `Done · 12.4s` line, which the server computes from the same
 * instant. The scan mirrors `turnInFlight` in `use-turn-submission.ts`: backwards, and an
 * ending seen before a start means the last turn is over.
 */
export function turnStartedAt(events: readonly StoredEvent[]): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined) continue;
    if (event.type === "turn.completed" || event.type === "turn.failed") return undefined;
    if (event.type === "turn.started") return event.createdAt;
  }
  return undefined;
}
