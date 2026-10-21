/**
 * Transcript items into the rows the timeline draws.
 *
 * This is the third fold. `buildTranscript` turns events into items — one per thing that happened
 * — and this decides how much of that a reader is shown at once. The answer, taken from T3 Code's
 * chat timeline (`MessagesTimeline.logic.ts`, MIT — see `apps/web/THIRD_PARTY_NOTICES.md`), is
 * very little:
 *
 *   - **A finished turn folds.** Everything between the prompt and the agent's final answer —
 *     reasoning, tool calls, the prose in between — goes behind one "Worked for 1m 12s" row
 *     placed under the prompt. What is left is the conversation: what was asked, what came back.
 *   - **A run of tool calls is one row**, named in a sentence ("Read 3 files and ran 2
 *     commands"), and the reasoning between the calls is part of the run rather than prose in the
 *     conversation. Prose still divides runs: it is the model saying what it just did and what it
 *     is about to do, and folding across it would file the explanation under the wrong half.
 *   - **While a turn runs, the newest call is the only one drawn**, as one live row at the end,
 *     with the rest of its run behind it; "Working for 12s" sits under the prompt. The live row
 *     keeps one id from "Thinking" to "Running bun" and back, so it changes in place.
 *
 * Open state is passed in rather than kept here, so the function stays pure: the component holds
 * two sets of ids and this reads them. Every id is derived from the key of the item a row opened
 * with, never the newest — the same rule `transcript.ts` follows for coalesced prose, and for the
 * same reason: keyed to the newest member, a group somebody had opened would spring shut the next
 * time a tool answered.
 */

import type { FileChange, TranscriptItem } from "./transcript.ts";
import {
  entryFailed,
  formatDuration,
  latestThought,
  summarizeToolGroup,
  type ToolGroupSummaryKind,
  toolGroupSummaryKind,
  type WorkEntry,
} from "./work-log.ts";

type Step = Extract<TranscriptItem, { kind: "step" }>;

/** The items that are drawn as themselves rather than folded into a work row. */
export type PassThroughItem = Exclude<TranscriptItem, WorkEntry>;

/**
 * The item keys a row stands for. The unseen seam is drawn above the first row that covers
 * anything the reader has not seen — including a fold or a group, whose members are not drawn.
 */
export type RowKeys = { first: number; last: number };

export type TimelineRow =
  | { kind: "item"; id: string; keys: RowKeys; item: PassThroughItem }
  /** A run of one: drawn as the entry itself, the way T3 draws a lone tool call. */
  | {
      kind: "work-entry";
      id: string;
      keys: RowKeys;
      groupId: string;
      entry: WorkEntry;
      /** Set when the run's sentence says more than the entry's own label would. */
      displayLabel: string | undefined;
    }
  | {
      kind: "work-toggle";
      id: string;
      keys: RowKeys;
      groupId: string;
      entries: WorkEntry[];
      summary: string;
      summaryKind: ToolGroupSummaryKind;
      hasFailure: boolean;
      expanded: boolean;
      at: string | undefined;
    }
  /** An opened group's members, under its toggle or under the live row. */
  | { kind: "work-group"; id: string; keys: RowKeys; groupId: string; entries: WorkEntry[] }
  | {
      kind: "work-live";
      id: typeof LIVE_ACTIVITY_ROW_ID;
      keys: RowKeys | undefined;
      /** The open run behind the row, if there is one to open. */
      groupId: string | undefined;
      entries: WorkEntry[];
      /** The call to name, or undefined while the model is thinking. */
      entry: Step | Extract<WorkEntry, { kind: "files" }> | undefined;
      /** One line of the newest reasoning in the run, previewed above the row. */
      thought: string | undefined;
      expanded: boolean;
    }
  | { kind: "working"; id: "working"; keys: undefined; startedAt: string | undefined }
  | {
      kind: "turn-fold";
      id: string;
      keys: RowKeys;
      foldId: string;
      label: string;
      expanded: boolean;
      at: string | undefined;
    }
  | { kind: "changed-files"; id: string; keys: undefined; files: FileChange[] };

/**
 * The live row's id, shared by "Thinking" and the call it is running, so React keeps one element
 * and the row changes in place instead of remounting — which would restart its shimmer every time
 * a tool was called.
 */
export const LIVE_ACTIVITY_ROW_ID = "live-activity";

export type TimelineOptions = {
  /**
   * Whether a turn is in flight, from the pane. It cannot be read off the items: the click that
   * sends a prompt is running long before anything is in the log, and a client that joined
   * mid-turn has no `turn.started` to read it from.
   */
  running: boolean;
  /** When the server says the open turn began, for the "Working for" clock. */
  startedAt?: string | undefined;
  expandedFolds: ReadonlySet<string>;
  expandedGroups: ReadonlySet<string>;
};

function isWorkEntry(item: TranscriptItem): item is WorkEntry {
  return item.kind === "step" || item.kind === "thinking" || item.kind === "files";
}

function isPrompt(item: TranscriptItem): boolean {
  return item.kind === "message" && item.from !== "agent";
}

/**
 * Reasoning with nothing in it has nothing to show, and a group row for it would be a row that
 * opens onto nothing.
 */
function visible(entry: WorkEntry): boolean {
  return entry.kind !== "thinking" || entry.text.trim() !== "";
}

const groupIdOf = (entry: WorkEntry) => `group:${entry.key}`;

function keysOf(items: readonly { key: number }[]): RowKeys {
  const keys = items.map((item) => item.key);
  return { first: Math.min(...keys), last: Math.max(...keys) };
}

type TurnFold = {
  foldId: string;
  /** The index of the item the fold row is drawn above: the first one after the prompt. */
  anchor: number;
  /** Indices of the items behind the row. */
  hidden: ReadonlySet<number>;
  label: string;
  at: string | undefined;
  keys: RowKeys;
};

type Turn = {
  prompt: number;
  /** One past the last index that belongs to this response. */
  end: number;
  turnEnd: Extract<TranscriptItem, { kind: "turn-end" }> | undefined;
  turnEndIndex: number;
  turnStart: Extract<TranscriptItem, { kind: "turn-start" }> | undefined;
  /** The agent's final answer: the last thing it said before the turn ended. */
  terminal: number;
};

/** The responses in the log, each from a prompt to the next one. */
function turnsOf(items: readonly TranscriptItem[]): Turn[] {
  const prompts = items.flatMap((item, index) => (isPrompt(item) ? [index] : []));

  return prompts.map((prompt, at) => {
    const end = prompts[at + 1] ?? items.length;
    let turnEndIndex = -1;
    let turnStart: Turn["turnStart"];
    for (let index = prompt + 1; index < end; index += 1) {
      const item = items[index];
      if (item?.kind === "turn-end") turnEndIndex = index;
      if (item?.kind === "turn-start") turnStart ??= item;
    }
    const turnEndItem = items[turnEndIndex];
    let terminal = -1;
    for (let index = (turnEndIndex === -1 ? end : turnEndIndex) - 1; index > prompt; index -= 1) {
      const item = items[index];
      if (item?.kind === "message" && item.from === "agent") {
        terminal = index;
        break;
      }
    }

    return {
      prompt,
      end,
      turnEnd: turnEndItem?.kind === "turn-end" ? turnEndItem : undefined,
      turnEndIndex,
      turnStart,
      terminal,
    };
  });
}

/**
 * Which finished turns fold, and what each fold hides.
 *
 * A turn folds once it has ended, completed or stopped by the user. One that failed for any other
 * reason stays open, because the work that led to a failure is exactly what somebody reading the
 * failure needs. Behind the row goes the agent's work — tool calls, reasoning, and the prose it
 * wrote along the way — up to its final answer, plus anything after the answer that did not fail.
 * What stays out is everything that is not the agent working: the turn's outcome, notices, the
 * compaction row and the preview's announcement.
 */
export function deriveTurnFolds(items: readonly TranscriptItem[]): TurnFold[] {
  const folds: TurnFold[] = [];

  for (const turn of turnsOf(items)) {
    const { turnEnd } = turn;
    if (turnEnd === undefined) continue;
    const cancelled = turnEnd.outcome === "failed" && turnEnd.reason === "cancelled";
    if (turnEnd.outcome === "failed" && !cancelled) continue;

    const hidden = new Set<number>();
    for (let index = turn.prompt + 1; index < turn.turnEndIndex; index += 1) {
      const item = items[index];
      if (item === undefined || index === turn.terminal) continue;
      const beforeAnswer = turn.terminal === -1 || index < turn.terminal;
      if (
        isWorkEntry(item)
          ? beforeAnswer || !entryFailed(item)
          : beforeAnswer && item.kind === "message"
      ) {
        hidden.add(index);
      }
    }
    if (hidden.size === 0) continue;

    const startedAt = turn.turnStart?.at;
    const elapsed =
      turnEnd.outcome === "completed"
        ? turnEnd.durationMs
        : startedAt === undefined
          ? undefined
          : Date.parse(turnEnd.at) - Date.parse(startedAt);
    const duration =
      elapsed === undefined || Number.isNaN(elapsed) ? undefined : formatDuration(elapsed);
    const label = cancelled
      ? duration === undefined
        ? "You stopped this response"
        : `You stopped after ${duration}`
      : duration === undefined
        ? "Worked"
        : `Worked for ${duration}`;

    const prompt = items[turn.prompt];
    folds.push({
      foldId: `fold:${prompt?.key ?? turn.prompt}`,
      anchor: turn.prompt + 1,
      hidden,
      label,
      at: startedAt ?? turnEnd.at,
      keys: keysOf([...hidden].flatMap((index) => items[index] ?? [])),
    });
  }

  return folds;
}

/**
 * What a completed turn changed, one entry per path, in the order each was first touched.
 *
 * Only a *completed* turn: a failed or stopped one leaves the workspace at the last good commit,
 * so the changes its calls reported were never kept, and listing them would describe a project
 * that does not exist.
 */
function changedFiles(items: readonly TranscriptItem[], turn: Turn): FileChange[] {
  if (turn.turnEnd?.outcome !== "completed") return [];
  const byPath = new Map<string, FileChange>();
  for (let index = turn.prompt + 1; index < turn.turnEndIndex; index += 1) {
    const item = items[index];
    if (item?.kind !== "step" && item?.kind !== "files") continue;
    for (const file of item.files) {
      const seen = byPath.get(file.path);
      if (seen === undefined) byPath.set(file.path, { ...file });
      else {
        seen.added += file.added;
        seen.removed += file.removed;
        seen.diff += file.diff;
        // A file created this turn is still a created file after its later edits.
        if (file.changeType === "deleted" || seen.changeType !== "created") {
          seen.changeType = file.changeType;
        }
      }
    }
  }
  return [...byPath.values()];
}

export function buildTimeline(
  items: readonly TranscriptItem[],
  options: TimelineOptions,
): TimelineRow[] {
  const { running, expandedFolds, expandedGroups } = options;
  const folds = deriveTurnFolds(items);
  const foldAt = new Map(folds.map((fold) => [fold.anchor, fold]));
  const collapsed = new Set(
    folds.filter((fold) => !expandedFolds.has(fold.foldId)).flatMap((fold) => [...fold.hidden]),
  );

  const turns = turnsOf(items);
  const filesAfter = new Map<number, { id: string; files: FileChange[] }>();
  for (const turn of turns) {
    const files = changedFiles(items, turn);
    if (files.length === 0) continue;
    // Under the answer, or where the answer would be when the turn ended without one.
    const after = turn.terminal === -1 ? turn.turnEndIndex - 1 : turn.terminal;
    filesAfter.set(after, { id: `changed-files:${items[turn.prompt]?.key}`, files });
  }

  // The open turn is whatever follows the last turn that ended.
  const lastEnd = items.findLastIndex((item) => item.kind === "turn-end");
  const openStart = lastEnd + 1;
  const lastPrompt = items.findLastIndex(isPrompt);
  const workingAt = lastPrompt >= openStart ? lastPrompt + 1 : openStart;

  // While a turn runs, the work at the very end of the log is drawn by the live row, not as rows
  // of its own: the run the agent is in the middle of.
  let tailStart = items.length;
  if (running) {
    while (tailStart > openStart) {
      const item = items[tailStart - 1];
      if (item === undefined || !isWorkEntry(item)) break;
      tailStart -= 1;
    }
  }
  const compacting = items
    .slice(openStart)
    .some((item) => item.kind === "compaction" && item.status === "running");

  const rows: TimelineRow[] = [];
  let run: WorkEntry[] = [];

  const flush = () => {
    const entries = run.filter(visible);
    run = [];
    const [first] = entries;
    if (first === undefined) return;
    const groupId = groupIdOf(first);
    const keys = keysOf(entries);

    if (entries.length === 1) {
      rows.push({
        kind: "work-entry",
        id: groupId,
        keys,
        groupId,
        entry: first,
        // A lone change reads as what it amounts to, "Changed 1 file"; the path is in its body.
        displayLabel:
          first.kind === "files" ||
          (first.kind === "step" &&
            (first.toolName === "edit_file" || first.toolName === "write_file"))
            ? summarizeToolGroup(entries).summary
            : undefined,
      });
      return;
    }

    const { summary, hasFailure } = summarizeToolGroup(entries);
    const expanded = expandedGroups.has(groupId);
    rows.push({
      kind: "work-toggle",
      id: groupId,
      keys,
      groupId,
      entries,
      summary,
      summaryKind: toolGroupSummaryKind(entries),
      hasFailure,
      expanded,
      at: entries.find((entry): entry is Step => entry.kind === "step")?.at,
    });
    if (expanded) rows.push({ kind: "work-group", id: `${groupId}:list`, keys, groupId, entries });
  };

  for (let index = 0; index < tailStart; index += 1) {
    const item = items[index];
    if (item === undefined) continue;

    const fold = foldAt.get(index);
    if (fold !== undefined) {
      flush();
      rows.push({
        kind: "turn-fold",
        id: fold.foldId,
        keys: fold.keys,
        foldId: fold.foldId,
        label: fold.label,
        expanded: expandedFolds.has(fold.foldId),
        at: fold.at,
      });
    }
    if (running && index === workingAt) {
      flush();
      rows.push({ kind: "working", id: "working", keys: undefined, startedAt: options.startedAt });
    }
    if (collapsed.has(index)) continue;

    if (isWorkEntry(item)) run.push(item);
    else {
      flush();
      rows.push({
        kind: "item",
        id: `item:${item.key}`,
        keys: { first: item.key, last: item.key },
        item,
      });
    }

    const files = filesAfter.get(index);
    if (files !== undefined) {
      flush();
      rows.push({ kind: "changed-files", id: files.id, keys: undefined, files: files.files });
    }
  }
  flush();

  if (!running) return rows;
  if (workingAt >= tailStart) {
    rows.push({ kind: "working", id: "working", keys: undefined, startedAt: options.startedAt });
  }
  // Compaction draws its own progress; a "Thinking" row under it would be a second, wrong answer.
  if (compacting) return rows;

  const tail = items.slice(tailStart).filter(isWorkEntry).filter(visible);
  const [first] = tail;
  const tools = tail.filter(
    (entry): entry is Step | Extract<WorkEntry, { kind: "files" }> => entry.kind !== "thinking",
  );
  const latestRunning = tools.findLast(
    (entry) => entry.kind === "step" && entry.status === "running",
  );
  const latestTool = tools.at(-1);
  // A call that failed hands the turn back to the model, which is thinking again until it calls
  // something else. The failure stays behind the row rather than on it.
  const latestFailed =
    latestRunning === undefined && latestTool !== undefined && entryFailed(latestTool);
  const thinking = tail.findLast(
    (entry): entry is Extract<WorkEntry, { kind: "thinking" }> => entry.kind === "thinking",
  );
  const thought = thinking === undefined ? "" : latestThought(thinking.text);
  const groupId = first === undefined ? undefined : groupIdOf(first);
  const expanded = groupId !== undefined && expandedGroups.has(groupId);

  rows.push({
    kind: "work-live",
    id: LIVE_ACTIVITY_ROW_ID,
    keys: first === undefined ? undefined : keysOf(tail),
    groupId,
    entries: tail,
    entry: latestFailed ? undefined : (latestRunning ?? latestTool),
    thought: thought === "" ? undefined : thought,
    expanded,
  });
  if (expanded && groupId !== undefined) {
    rows.push({
      kind: "work-group",
      id: `${groupId}:list`,
      keys: keysOf(tail),
      groupId,
      entries: tail,
    });
  }

  return rows;
}
