"use client";

import type { MediaAttachment } from "@nap/shared/media";

/**
 * The transcript: a conversation, with the work folded away between its turns.
 *
 * What somebody is reading is an exchange — they asked for something, the agent went away and did
 * forty small things, and it came back — so the two voices are drawn as two voices, the user's
 * words in a bubble on the right and the agent's as markdown across the pane, and the forty small
 * things are a work log between them. That log is T3 Code's chat timeline, cloned (MIT — see
 * `apps/web/THIRD_PARTY_NOTICES.md`): 24px rows that sit flush in the conversation, one live row
 * for whatever is running, "Working for 12s" under the prompt while it does, and a finished
 * turn folded into one "Worked for 1m 12s" row with its answer beneath. `timeline.ts` decides
 * which rows there are; this draws them.
 *
 * The container is a `log` landmark, which is what makes new events announce themselves to a
 * screen reader instead of appearing silently — a transcript that only updates visually is
 * unusable for the person who most needs to know the agent is still working.
 */

import { useMemo, useState } from "react";
import { turnFailureCopy } from "../errors/failure-copy.ts";
import { AlertIcon, CopyIcon } from "../ui/icons.tsx";
import { ChangedFilesCard } from "./changed-files-card.tsx";
import { ChatMarkdown, ProjectFiles } from "./chat-markdown.tsx";
import { CompactionRow } from "./compaction-row.tsx";
import { OutputBlock } from "./output-block.tsx";
import { buildTimeline, type PassThroughItem, type TimelineRow } from "./timeline.ts";
import type { TranscriptItem } from "./transcript.ts";
import {
  LiveWorkRow,
  TurnFoldRow,
  WorkEntryRow,
  WorkGroupList,
  WorkingRow,
  WorkToggleRow,
} from "./work-log-rows.tsx";

type TurnEnd = Extract<TranscriptItem, { kind: "turn-end" }>;
type FailedTurn = Extract<TurnEnd, { outcome: "failed" }>;

export function ChatTranscript({
  items,
  running = false,
  pending = false,
  startedAt,
  onRetry,
  files = [],
  onOpenFile,
  onOpenChanges,
}: {
  /**
   * The log, already folded into items.
   *
   * Passed in rather than folded here because the pane above reads the same fold for the composer
   * and the context meter, and two components folding one log is two walks of it per frame of a
   * streaming turn. `buildTranscript(events)` is the whole derivation; see `transcript.ts`.
   */
  items: readonly TranscriptItem[];
  /**
   * Whether a turn is in flight, from the pane — which knows from the click, long before the log
   * does. It is what draws "Working for" and the live row; without it the newest work is drawn
   * like any other.
   */
  running?: boolean;
  /**
   * A request was sent and the log does not hold it yet. `running` alone cannot say whether a log
   * ending at a turn end has anything still to come: see `TimelineOptions` in `timeline.ts`.
   */
  pending?: boolean;
  /** When the server says the open turn began. Absent until `turn.started` arrives. */
  startedAt?: string | undefined;
  /** Re-sends a failed turn's message. Absent means no retry is offered, not a broken button. */
  onRetry?: ((message: string, attachments?: MediaAttachment[]) => void) | undefined;
  /** The project's files, so a path in a reply can become a chip that opens it. */
  files?: readonly string[] | undefined;
  /** Opens a file in the Code tab. Absent, a path is still a chip, just not a button. */
  onOpenFile?: ((path: string) => void) | undefined;
  onOpenChanges?: (() => void) | undefined;
}) {
  // Which folds and groups the reader has opened, by the ids `timeline.ts` derives from the item
  // each opened with — stable as the turn grows, so nothing springs shut mid-turn.
  const [openFolds, setOpenFolds] = useState<ReadonlySet<string>>(() => new Set());
  const [openGroups, setOpenGroups] = useState<ReadonlySet<string>>(() => new Set());
  const rows = useMemo(
    () =>
      buildTimeline(items, {
        running,
        pending,
        startedAt,
        expandedFolds: openFolds,
        expandedGroups: openGroups,
      }),
    [items, running, pending, startedAt, openFolds, openGroups],
  );
  const projectFiles = useMemo(
    () => ({ files, onOpenFile, onOpenChanges }),
    [files, onOpenFile, onOpenChanges],
  );

  // The only prose that can still be added to is the last item — everything above it has been
  // overtaken by something newer. That alone is the whole rule, and it needs no check for whether
  // a turn is open: a turn that ended ends *with* its `turn.completed` or `turn.failed`, so
  // replaying a finished session leaves the last word on a line that has no prose to fade in. A
  // client that reconnected mid-turn has no `turn.started`, and the passage the model is writing
  // right now is exactly what asking for one would refuse to stream.
  const liveKey = items.at(-1)?.key;

  const compactionFailures = new Map<number, FailedTurn>();
  const foldedFailures = new Set<number>();
  for (const item of items) {
    if (item.kind !== "turn-end" || item.outcome !== "failed") continue;
    if (item.compactionFailureKey === undefined) continue;
    compactionFailures.set(item.compactionFailureKey, item);
    foldedFailures.add(item.key);
  }

  const toggle = (set: typeof setOpenFolds, id: string) =>
    set((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  let previous: TimelineRow | undefined;

  return (
    <ProjectFiles value={projectFiles}>
      <div
        // A `log`, not a `list`: additions are announced, which is the point of a transcript that
        // grows while you watch it. Its children are deliberately plain elements — `listitem`
        // under a `log` is an orphaned role, and the rows are heterogeneous blocks rather than
        // peers in a list.
        role="log"
        aria-label="Transcript"
        className="mx-auto flex max-w-[46rem] flex-col px-5 py-6"
      >
        {rows.map((row) => {
          // A turn that finished draws nothing of its own — its fold says how long it took — and
          // a compaction's failure is drawn inside the compaction's row. Neither takes a wrapper.
          const drawnElsewhere = row.kind === "item" && foldedFailures.has(row.item.key);
          if (drawnElsewhere || isFinished(row)) return null;
          const before = previous;
          if (!quiet(row)) previous = row;
          return (
            <div key={row.id} className={spacingBefore(row, before)}>
              <Row
                row={row}
                live={row.kind === "item" && row.item.key === liveKey}
                compactionFailure={
                  row.kind === "item" ? compactionFailures.get(row.item.key) : undefined
                }
                onRetry={onRetry}
                onToggleFold={(id) => toggle(setOpenFolds, id)}
                onToggleGroup={(id) => toggle(setOpenGroups, id)}
              />
            </div>
          );
        })}
      </div>
    </ProjectFiles>
  );
}

function isFinished(row: TimelineRow): boolean {
  return row.kind === "item" && row.item.kind === "turn-end" && row.item.outcome === "completed";
}

/** Rows of the work log, which sit flush against one another the way T3 draws them. */
function isWorkRow(row: TimelineRow): boolean {
  return row.kind !== "item" && row.kind !== "changed-files";
}

/**
 * Rows with nothing visible on them: announced to a screen reader, drawn as nothing. They take no
 * space and do not count as what came before, or every turn would open with a gap.
 */
function quiet(row: TimelineRow): boolean {
  if (row.kind !== "item") return false;
  const { item } = row;
  return (
    item.kind === "preview" ||
    item.kind === "turn-start" ||
    (item.kind === "preview-stopped" && item.superseded) ||
    (item.kind === "turn-end" && item.outcome === "completed")
  );
}

function spacingBefore(row: TimelineRow, previous: TimelineRow | undefined): string {
  if (previous === undefined || quiet(row)) return "";
  if (isWorkRow(row) && isWorkRow(previous)) return "";
  // A fold or working row hangs off the prompt above it.
  if (row.kind === "turn-fold" || row.kind === "working") return "mt-2";
  return isWorkRow(row) && previous.kind === "turn-fold" ? "mt-2" : "mt-5";
}

function Row({
  row,
  live,
  compactionFailure,
  onRetry,
  onToggleFold,
  onToggleGroup,
}: {
  row: TimelineRow;
  live: boolean;
  compactionFailure: FailedTurn | undefined;
  onRetry?: ((message: string, attachments?: MediaAttachment[]) => void) | undefined;
  onToggleFold: (id: string) => void;
  onToggleGroup: (id: string) => void;
}) {
  switch (row.kind) {
    case "item":
      return (
        <Item item={row.item} live={live} compactionFailure={compactionFailure} onRetry={onRetry} />
      );
    case "work-entry":
      return <WorkEntryRow entry={row.entry} displayLabel={row.displayLabel} />;
    case "work-toggle":
      return <WorkToggleRow row={row} onToggle={() => onToggleGroup(row.groupId)} />;
    case "work-group":
      return <WorkGroupList entries={row.entries} />;
    case "work-live":
      return (
        <LiveWorkRow
          row={row}
          onToggle={() => row.groupId !== undefined && onToggleGroup(row.groupId)}
        />
      );
    case "working":
      return <WorkingRow startedAt={row.startedAt} />;
    case "turn-fold":
      return <TurnFoldRow row={row} onToggle={() => onToggleFold(row.foldId)} />;
    case "changed-files":
      return <ChangedFilesCard files={row.files} />;
  }
}

function Item({
  item,
  live,
  onRetry,
  compactionFailure,
}: {
  item: PassThroughItem;
  compactionFailure?: FailedTurn | undefined;
  /** Whether this item can still be added to. Only ever true of the last one, mid-turn. */
  live: boolean;
  onRetry?: ((message: string, attachments?: MediaAttachment[]) => void) | undefined;
}) {
  switch (item.kind) {
    case "compaction":
      return (
        <CompactionRow
          item={item}
          recovery={
            compactionFailure !== undefined ? (
              <TurnFailure item={compactionFailure} onRetry={onRetry} insideCompaction />
            ) : undefined
          }
        />
      );
    case "message":
      // A prompt the verifier wrote is neither of the two voices below, and drawing it as
      // either is the specific thing this treatment exists to prevent: in a user bubble it
      // reads as the app talking to itself, and as agent prose it reads as the model narrating
      // its own failure. It is the system quoting a check back at the model, so it is labelled
      // as such and set in the machine's face. See `docs/adr/0006`.
      if (item.from === "verifier") return <RepairPrompt text={item.text} />;

      // The user's words in a bubble on the right, the agent's as prose across the pane. The
      // asymmetry is deliberate and it is the oldest convention in the medium: what you said is
      // a short thing you can find again by its shape, and what the agent said is something to
      // read. Making both bubbles gives a paragraph of explanation the shape of a text message.
      return item.from === "user" ? (
        <div className="flex justify-end pt-1">
          <div className="chat-user-message">
            {item.attachments?.map((attachment) => (
              <div key={attachment.name} className="mb-3">
                <div className={attachment.kind === "video" ? "grid grid-cols-3 gap-2" : "flex"}>
                  {attachment.frames.map((frame) => (
                    <figure key={frame.timestamp}>
                      {/* biome-ignore lint/performance/noImgElement: prepared attachments are inline image data. */}
                      <img
                        src={`data:${frame.mediaType};base64,${frame.data}`}
                        alt={
                          attachment.kind === "video"
                            ? `${attachment.name} at ${frame.timestamp.toFixed(1)}s`
                            : attachment.name
                        }
                        className="max-h-40 max-w-full rounded-lg object-contain"
                      />
                      {attachment.kind === "video" && (
                        <figcaption className="mt-1 text-xs text-muted">
                          {frame.timestamp.toFixed(1)}s
                        </figcaption>
                      )}
                    </figure>
                  ))}
                </div>
                <p className="mt-1 truncate text-xs text-muted" title={attachment.name}>
                  {attachment.name}
                </p>
              </div>
            ))}
            <p className="whitespace-pre-wrap">
              {/*
              Read aloud but not drawn: the two speakers are told apart visually by position and
              shape, which is nothing at all to someone listening to the page.
            */}
              <span className="sr-only">You: </span>
              {item.text}
            </p>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <span className="sr-only">Agent: </span>
          <ChatMarkdown text={item.text} streaming={live} />
          <CopyButton text={item.text} />
        </div>
      );

    case "preview":
      /*
       * **Announced, not drawn.** This used to be a visible meta row reading "Preview ready ·
       * 5173-i59080byuko8pdezzh7u6.e2b.app", and on screen it is pure noise: the bar above
       * already shows the host, the bar already has a link to open it, and the Preview tab is
       * showing the running app. A restarting dev server emits another one, so a long session
       * silts up with thirty-character subdomains nobody reads.
       *
       * It survives for somebody who cannot see any of that. "The app is running, and here is
       * where" is real information, and the log is the only place it reaches them — so the text
       * and the link stay in the accessibility tree while nothing appears in the transcript.
       */
      return (
        <p className="sr-only">
          Preview ready ·{" "}
          <a
            href={item.url}
            target="_blank"
            // The preview is the user's own app served from another origin; `noopener` keeps
            // it from reaching back into this tab.
            rel="noopener noreferrer"
          >
            {new URL(item.url).host}
          </a>
        </p>
      );

    case "preview-stopped":
      // The one that still describes the project gets a line; the ones a later restart already
      // answered stay in the log for anybody listening to it, and stay out of the way for
      // everybody reading it. Five identical "put away" lines in a transcript read as five
      // failures rather than as an afternoon of ordinary opening and closing.
      return item.superseded ? (
        <p className="sr-only">Preview stopped · the project was put away</p>
      ) : (
        <Meta>Preview stopped · the project was put away</Meta>
      );

    case "notice":
      // Labelled in words rather than by colour, so it survives being read aloud and being read
      // by someone who cannot tell the two colours apart.
      return (
        <p
          className={`font-mono text-[11.5px] leading-relaxed ${
            item.level === "warning" ? "text-danger" : "text-muted"
          }`}
        >
          <span className="uppercase tracking-wide">
            {item.level === "warning" ? "Warning" : "Note"}
          </span>{" "}
          · {item.text}
        </p>
      );

    case "turn-start":
      // **Words, not a line.** A turn boundary is real information to somebody listening, and the
      // bubble above it already says to everybody else that a turn began — the timeline's own
      // rows ("Working for", "Worked for") carry the boundary on screen. No `role="separator"`:
      // that role is for a widget dividing two panes.
      //
      // A repair turn differs here only in what it is called: "turn started" would tell somebody
      // listening that the user said something, which for a repair is the one thing that is not
      // true.
      return (
        <p className="sr-only">
          {item.source === "verification" ? "Repair turn started" : "Turn started"}
        </p>
      );

    case "turn-end":
      return item.outcome === "completed" ? null : <TurnFailure item={item} onRetry={onRetry} />;
  }
}

/**
 * Taking one passage of the agent's prose away with you.
 *
 * Scoped to the passage rather than to the turn on purpose. A turn is prose, tool calls, streamed
 * output and a commit line, and "copy" on all of that hands somebody four kilobytes of `vite`
 * banner when they wanted the sentence explaining what changed. The fold has already decided where
 * a passage ends — `transcript.ts` joins a run of `agent.message` events and refuses to join across
 * a tool step — so the boundary this copies is one the reader can see.
 */
function CopyButton({ text }: { text: string }) {
  return (
    <button
      type="button"
      // Named rather than labelled by its glyph: the icon is the only thing drawn, so without
      // this the control reads as "button" to anyone listening.
      aria-label="Copy response"
      onClick={() => {
        // Nothing to do with the promise. It rejects when the document is not focused or the
        // permission is refused, and neither is something to tell the reader about mid-transcript.
        void navigator.clipboard?.writeText(text);
      }}
      className="self-start rounded-chip p-1 text-muted transition-colors hover:bg-hover hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
    >
      <CopyIcon className="size-3.5" />
    </button>
  );
}

/**
 * What a failed check asked the model to do.
 *
 * The heading is the whole point of the treatment: a reader has to be able to see, without
 * reading a word of the prompt, that the next turn was prompted by the project's own checks
 * rather than by them. Self-correction that looks like the app addressing itself in the user's
 * voice reads as a bug, and it is the demo's best moment.
 *
 * Clamped from the top rather than the bottom. The prompt opens by naming the check that
 * failed and closes with a fenced copy of what it printed, which the verifier budgets at four
 * kilobytes a stream — keeping the tail of that would fill the pane with a stack trace and cut
 * off the sentence saying which check produced it.
 */
function RepairPrompt({ text }: { text: string }) {
  return (
    <div className="flex flex-col rounded-xl border border-edge bg-field/50 px-3 py-2.5">
      <p className="flex items-center gap-1.5 font-medium text-[11.5px] text-muted uppercase tracking-wide">
        <AlertIcon className="size-3.5 shrink-0" />
        Verification asked for a repair
      </p>
      <OutputBlock text={text} keep="head" />
    </div>
  );
}

/**
 * A line about the turn rather than from it.
 *
 * Centred between two hairlines, so it reads as a boundary in the conversation instead of as
 * something one of the two speakers said.
 */
function Meta({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-center gap-2.5 font-mono text-[11px] text-muted">
      <span aria-hidden="true" className="h-px flex-1 bg-edge" />
      {/*
        `min-w-0 truncate` rather than `shrink-0`. A row that cannot shrink pushes the pane
        wider than the window and gives the whole transcript a horizontal scrollbar — which is
        what happened here. Shortening the text that caused it is not the fix; letting the row
        shrink is, so the next long meta line cannot bring the scrollbar back.
      */}
      <span className="min-w-0 truncate">{children}</span>
      <span aria-hidden="true" className="h-px flex-1 bg-edge" />
    </p>
  );
}

/**
 * A failed turn, said in a way somebody can act on.
 *
 * Three parts, and each earns its place: what failed, the specific reason the server gave, and
 * what to do about it. The old version of this was one mono line reading `Failed · sandbox
 * unavailable · <message>`, which names the failure in the system's vocabulary and stops there.
 *
 * The button appears only when retrying is the right advice *and* there is something to send.
 * A turn that ran out of budget would fail identically on a retry, and a log joined mid-turn has
 * no message to resend — in both cases the action is prose, because a control that cannot help
 * is worse than none.
 */
function TurnFailure({
  item,
  onRetry,
  insideCompaction = false,
}: {
  item: FailedTurn;
  onRetry?: ((message: string, attachments?: MediaAttachment[]) => void) | undefined;
  insideCompaction?: boolean;
}) {
  const message = item.retryMessage;
  const copy =
    message === "/compact"
      ? {
          title: item.reason === "cancelled" ? "Compaction stopped." : "Compaction failed.",
          detail: item.message,
          action: "Your original conversation is still available.",
          recovery: item.reason === "cancelled" ? "none" : "retry",
        }
      : turnFailureCopy(item.reason, item.message);
  const canRetry =
    copy.recovery === "retry" && onRetry !== undefined && message !== undefined && message !== "";

  return (
    <div
      className={
        insideCompaction
          ? "flex flex-col gap-1"
          : `flex flex-col gap-1 rounded-xl border px-3 py-2.5 ${item.reason === "cancelled" ? "border-edge" : "border-danger/30 bg-danger/[0.06]"}`
      }
    >
      {!insideCompaction && (
        <p
          className={`font-medium text-[13px] ${item.reason === "cancelled" ? "text-muted" : "text-danger"}`}
        >
          {copy.title}
        </p>
      )}
      {/* Mono, because this half is the machine talking — the same split the rest of the pane uses. */}
      <p className="break-words font-mono text-[11px] text-muted">{copy.detail}</p>
      <p className="text-[12px] text-muted">{copy.action}</p>

      {canRetry && (
        <button
          type="button"
          onClick={() =>
            item.retryAttachments === undefined
              ? onRetry(message)
              : onRetry(message, item.retryAttachments)
          }
          className={`mt-1.5 self-start rounded-chip border border-edge px-2 py-1 text-[11px] text-ink-2 transition-colors hover:bg-hover hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent ${insideCompaction ? "min-h-8" : ""}`}
        >
          Try again
        </button>
      )}
    </div>
  );
}
