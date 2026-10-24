"use client";

/**
 * The rows of the work log: every tool call, thought, group and turn summary in the timeline is
 * drawn with the same 24px row.
 *
 * Cloned from T3 Code's `WorkLog.tsx` and the timeline rows built on it in `MessagesTimeline.tsx`
 * (MIT — see `apps/web/THIRD_PARTY_NOTICES.md`): a 24px icon slot holding a 16px icon, a muted
 * label truncated to one line, the time on hover, and a 12px chevron that turns 90° when the row
 * opens. No card and no border — the rows sit flush in the conversation, so twenty of them read
 * as one quiet list rather than twenty boxes. Sizes and motion are T3's; colours are this app's
 * tokens.
 *
 * One deliberate difference: T3 makes an expandable row a `div` with `role="button"`, so its
 * expanded detail can sit inside it. Here the row is a wrapper holding a real `<button>` and the
 * detail beside it — the same layout, with the platform's own button semantics and keyboard
 * handling instead of a hand-written copy of them.
 */

import {
  Brain,
  ChevronDown,
  ChevronRight,
  Eye,
  Hammer,
  Monitor,
  Search,
  SquarePen,
  Terminal,
  X,
} from "lucide-react";
import {
  createContext,
  type ReactNode,
  use,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { TimelineRow } from "./timeline.ts";
import { WorkEntryBody } from "./tool-body.tsx";
import { observeVisibleAnimation } from "./visible-animation.ts";
import {
  entryFailed,
  formatDuration,
  liveWorkEntryLabel,
  type ToolGroupSummaryKind,
  toolGroupAction,
  type WorkEntry,
  workEntryDisplayLabel,
} from "./work-log.ts";

const GroupedRows = createContext(false);

/** A run of rows that belong together, drawn with no space between them. */
export function WorkLogList({ children }: { children: ReactNode }) {
  return (
    <GroupedRows value>
      <div className="flex min-w-0 flex-col">{children}</div>
    </GroupedRows>
  );
}

function WorkLogLine({
  icon,
  label,
  trailing,
  wrapLabel = false,
}: {
  icon?: ReactNode;
  label: ReactNode;
  trailing?: ReactNode;
  wrapLabel?: boolean | undefined;
}) {
  return (
    <div
      className={`flex min-h-6 min-w-0 select-none gap-1.5 text-sm leading-relaxed [&_*]:select-none ${
        wrapLabel ? "items-start" : "items-center"
      }`}
    >
      <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
        {icon !== undefined && (
          <span className="relative w-6 shrink-0 leading-0">
            <span className="inline-block size-6 overflow-hidden align-[calc(0.5cap_-_0.75rem)]">
              <span className="flex size-full items-center justify-center">{icon}</span>
            </span>
          </span>
        )}
        <div
          className={`min-w-0 flex-1 text-muted ${wrapLabel ? "" : "truncate [&_*]:whitespace-nowrap"}`}
        >
          {label}
        </div>
      </div>
      {trailing}
    </div>
  );
}

function useRowClassName() {
  const grouped = use(GroupedRows);
  return `group/timeline-row relative w-full min-w-0 rounded-md px-0.5 text-left transition-colors ${
    grouped ? "py-0" : "py-0.5"
  }`;
}

const INTERACTIVE =
  "w-full cursor-pointer rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/70";

/** A row, with whatever it opens onto beneath it. */
export function WorkLogRow({
  icon,
  label,
  trailing,
  wrapLabel,
  children,
}: {
  icon?: ReactNode;
  label: ReactNode;
  trailing?: ReactNode;
  wrapLabel?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={useRowClassName()}>
      <WorkLogLine icon={icon} label={label} trailing={trailing} wrapLabel={wrapLabel} />
      {children}
    </div>
  );
}

/** A row that is itself the control: a group's summary, a turn's fold. */
export function WorkLogButton({
  icon,
  label,
  trailing,
  expanded,
  name,
  onToggle,
  children,
  ref,
}: {
  icon?: ReactNode;
  label: ReactNode;
  trailing?: ReactNode;
  expanded: boolean;
  /** The row's accessible name. Set explicitly so the hover timestamp is never read as part of it. */
  name: string;
  onToggle: () => void;
  children?: ReactNode;
  ref?: React.Ref<HTMLButtonElement> | undefined;
}) {
  return (
    <div className={useRowClassName()}>
      <button
        ref={ref}
        type="button"
        aria-expanded={expanded}
        aria-label={name}
        onClick={onToggle}
        className={INTERACTIVE}
      >
        <WorkLogLine icon={icon} label={label} trailing={trailing} />
      </button>
      {children}
    </div>
  );
}

/**
 * What an opened row shows. `followLive` keeps output that is still arriving scrolled to its end
 * — unless the reader has scrolled up into it, and then it stays where they put it.
 */
export function WorkLogDetails({
  children,
  kind = "text",
  followLive = false,
}: {
  children: ReactNode;
  kind?: "text" | "panel";
  followLive?: boolean;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const atLiveEdge = useRef(true);
  // No dependencies: every streamed chunk re-renders this, and pinning before paint shows the
  // new text without a visible jump.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (followLive && atLiveEdge.current && element !== null) {
      element.scrollTop = element.scrollHeight;
    }
  });

  return (
    <div
      ref={scroller}
      onScroll={(event) => {
        const { scrollHeight, scrollTop, clientHeight } = event.currentTarget;
        atLiveEdge.current = scrollHeight - scrollTop - clientHeight <= 4;
      }}
      className={
        kind === "text"
          ? "ms-7 flex max-h-96 cursor-auto select-text flex-col gap-3 overflow-auto px-0.5 py-1"
          : "mt-0.5 mb-1.5 cursor-auto pb-2"
      }
    >
      {children}
    </div>
  );
}

const noSubscription = () => () => {};

/**
 * When a row happened, shown only while the row is hovered or holds focus.
 *
 * The clock is the reader's, in their locale and timezone, and the server rendering the page knows
 * neither: formatted there, "7:01 PM" hydrates against "19:01" and React throws the tree away.
 * So the server renders the element empty and the browser fills it in — nothing is lost, since
 * nobody can hover a row before the page is interactive.
 */
function Timestamp({ at, className = "" }: { at: string | undefined; className?: string }) {
  const inBrowser = useSyncExternalStore(
    noSubscription,
    () => true,
    () => false,
  );
  if (at === undefined) return null;
  const time = new Date(at);
  if (Number.isNaN(time.getTime())) return null;
  return (
    <time
      dateTime={at}
      className={`pointer-events-none absolute me-1 shrink-0 whitespace-nowrap rounded-md text-muted text-xs tabular-nums opacity-0 group-hover/timeline-row:pointer-events-auto group-hover/timeline-row:static group-hover/timeline-row:opacity-100 group-focus-within/timeline-row:pointer-events-auto group-focus-within/timeline-row:static group-focus-within/timeline-row:opacity-100 ${className}`}
    >
      {inBrowser ? time.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : ""}
    </time>
  );
}

const ICON = "block size-4 shrink-0 stroke-2";

/** The kind of work, as a shape: eye a read, pen a change, terminal a command, magnifier a search. */
function EntryIcon({ kind, className = ICON }: { kind: ToolGroupSummaryKind; className?: string }) {
  switch (kind) {
    case "computer":
      return <Monitor aria-hidden="true" className={className} />;
    case "read":
      return <Eye aria-hidden="true" className={className} />;
    case "edit":
      return <SquarePen aria-hidden="true" className={className} />;
    case "command":
      return <Terminal aria-hidden="true" className={className} />;
    case "code-search":
      return <Search aria-hidden="true" className={className} />;
    case "reasoning":
      return <Brain aria-hidden="true" className={className} />;
    case "mixed":
      return <Hammer aria-hidden="true" className={className} />;
  }
}

function entryKind(entry: WorkEntry): ToolGroupSummaryKind {
  return entry.kind === "thinking" ? "reasoning" : toolGroupAction(entry);
}

/** The slot an icon sits in, tinted for a failure. Failure is said in words too, never by colour alone. */
function IconSlot({ children, failed = false }: { children: ReactNode; failed?: boolean }) {
  return (
    <span
      className={`flex size-4 items-center justify-center ${failed ? "text-danger" : "text-muted"}`}
    >
      {children}
    </span>
  );
}

const FailedMark = () => <X aria-hidden="true" className="size-3 shrink-0 text-danger" />;

function Chevron({ expanded, hidden = false }: { expanded: boolean; hidden?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`flex size-4 shrink-0 items-center justify-center ${hidden ? "invisible" : ""}`}
    >
      <ChevronRight
        className={`size-3 shrink-0 text-muted opacity-70 transition-transform duration-200 ${
          expanded ? "rotate-90" : ""
        }`}
      />
    </span>
  );
}

/**
 * One tool call, thought or file change. Opens onto what it did: the command and its output, the
 * diff, the full reasoning. A call still out says so to somebody listening, since the live row
 * that says it visually may be several rows away.
 */
export function WorkEntryRow({
  entry,
  displayLabel,
}: {
  entry: WorkEntry;
  displayLabel?: string | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const failed = entryFailed(entry);
  const running = entry.kind === "step" && entry.status === "running";
  const label = displayLabel ?? workEntryDisplayLabel(entry);
  const name = `${label}${running ? ", still running" : ""}${failed ? ", tool call failed" : ""}`;

  return (
    <div className={useRowClassName()}>
      <button
        type="button"
        aria-expanded={expanded}
        aria-label={name}
        onClick={() => setExpanded(!expanded)}
        className={INTERACTIVE}
      >
        <WorkLogLine
          icon={
            <IconSlot failed={failed}>
              <EntryIcon kind={entryKind(entry)} />
            </IconSlot>
          }
          label={
            <p className="flex w-full min-w-0 items-baseline gap-1.5 text-sm leading-relaxed">
              <span className="min-w-0 flex-1 truncate">{label}</span>
            </p>
          }
          trailing={
            <>
              {failed && <FailedMark />}
              <Timestamp at={entry.kind === "step" ? entry.at : undefined} />
              <Chevron expanded={expanded} />
            </>
          }
        />
        {/* Words, not only a name: an `aria-label` is not text, and "running" is a fact somebody
            searching the transcript for what is still going should find. */}
        {running && <span className="sr-only">still running</span>}
      </button>
      {expanded && (
        <WorkLogDetails kind={entry.kind === "thinking" ? "text" : "panel"}>
          <WorkEntryBody entry={entry} />
        </WorkLogDetails>
      )}
    </div>
  );
}

/**
 * An opened group's members. Not virtualised, unlike T3's: a Nap turn is tens of calls rather
 * than thousands. Capped at T3's height, and uncapped while one of its rows is open so a body
 * does not scroll inside a list that also scrolls.
 */
export function WorkGroupList({ entries }: { entries: readonly WorkEntry[] }) {
  return (
    <section
      aria-label="Tool calls"
      className="nap-scroll max-h-[min(18rem,50dvh)] overflow-y-auto overflow-x-hidden rounded-md has-[[aria-expanded=true]]:max-h-none"
    >
      <WorkLogList>
        {entries.map((entry) => (
          <WorkEntryRow key={entry.key} entry={entry} />
        ))}
      </WorkLogList>
    </section>
  );
}

/** A finished run, as the sentence it adds up to. Opening it lists the run beneath it. */
export function WorkToggleRow({
  row,
  onToggle,
}: {
  row: Extract<TimelineRow, { kind: "work-toggle" }>;
  onToggle: () => void;
}) {
  return (
    <WorkLogButton
      expanded={row.expanded}
      name={row.hasFailure ? `${row.summary}, tool call failed` : row.summary}
      onToggle={onToggle}
      icon={
        <IconSlot failed={row.hasFailure}>
          <EntryIcon kind={row.summaryKind} />
        </IconSlot>
      }
      label={<span className="block truncate">{row.summary}</span>}
      trailing={
        <>
          {row.hasFailure && <FailedMark />}
          <Timestamp at={row.at} />
        </>
      }
    />
  );
}

/**
 * The spotlight: a full-brightness copy of a row behind a moving mask. The copy's label is drawn
 * by CSS from `data-spotlight-text` (see `globals.css`), so the words are in the document once.
 */
function ActivityShimmerOverlay({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className="live-activity-focus pointer-events-none absolute inset-y-0 select-none"
    >
      <span className="live-activity-focus-counter block">
        <span className="live-activity-focus-aligned block text-ink">{children}</span>
      </span>
    </span>
  );
}

/** A label lit by the spotlight, for anything that is waiting rather than doing. */
export function Spotlight({
  label,
  className = "",
  icon,
}: {
  label: string;
  className?: string;
  icon?: ReactNode;
}) {
  return (
    <span
      ref={observeVisibleAnimation}
      className={`relative inline-flex overflow-hidden ${className}`}
    >
      <span className="inline-flex items-center gap-1.5">
        {icon}
        {label}
      </span>
      <ActivityShimmerOverlay>
        <span className="inline-flex items-center gap-1.5">
          {icon}
          <span data-spotlight-text={label} />
        </span>
      </ActivityShimmerOverlay>
    </span>
  );
}

function LiveActivityContent({
  label,
  kind,
  failed = false,
  shine = false,
  spotlightCopy = false,
}: {
  label: string;
  kind: ToolGroupSummaryKind;
  failed?: boolean;
  shine?: boolean;
  /** This is the spotlight's copy: the label comes from CSS, and the icon is lit. */
  spotlightCopy?: boolean;
}) {
  return (
    <WorkLogRow
      icon={
        <span
          className={`flex size-4 items-center justify-center ${
            failed ? "text-danger" : spotlightCopy ? "text-ink" : "text-muted"
          }`}
        >
          <EntryIcon kind={kind} />
        </span>
      }
      label={
        spotlightCopy ? (
          <span className="block truncate text-ink" data-spotlight-text={label} />
        ) : (
          <span className={`block truncate ${shine ? "live-tool-shine" : ""}`}>{label}</span>
        )
      }
      trailing={failed ? <FailedMark /> : undefined}
    />
  );
}

/**
 * One row for whatever the turn is doing now.
 *
 * Thinking, it is "Thinking" under the spotlight; running a tool, it is that tool — "Running bun"
 * — under the text shine. Either way it is the same element (`LIVE_ACTIVITY_ROW_ID`), so going
 * from one to the other changes the row in place rather than replacing it. Above it, when the
 * run has reasoning in it, the newest of that reasoning in up to four lines: the model that
 * streams its reasoning is the cheap one, and this is where somebody watching it sees it think.
 * The full text is behind the row, and behind the turn's fold once it ends.
 */
export function LiveWorkRow({
  row,
  onToggle,
}: {
  row: Extract<TimelineRow, { kind: "work-live" }>;
  onToggle: () => void;
}) {
  const { entry } = row;
  const thinking = entry === undefined;
  const label = thinking ? "Thinking" : liveWorkEntryLabel(entry, true);
  const failed = entry !== undefined && entryFailed(entry);
  const kind = thinking ? "reasoning" : toolGroupAction(entry);

  const activity = (
    <div
      ref={failed ? undefined : observeVisibleAnimation}
      className="relative min-h-6 w-fit min-w-0 max-w-full overflow-hidden rounded-md text-sm leading-relaxed"
    >
      <LiveActivityContent label={label} kind={kind} failed={failed} shine={!thinking && !failed} />
      {thinking && (
        <ActivityShimmerOverlay>
          <LiveActivityContent label={label} kind={kind} spotlightCopy />
        </ActivityShimmerOverlay>
      )}
    </div>
  );

  const thought = row.thought !== undefined && (
    <WorkLogRow
      icon={
        <IconSlot>
          <EntryIcon kind="reasoning" />
        </IconSlot>
      }
      // Reasoning grows several times a second, and the transcript is a live region: announced,
      // it would talk over everything else. The full passage is behind the row for anyone who
      // wants it read.
      label={
        <span aria-live="off" className="line-clamp-4">
          {row.thought}
        </span>
      }
      wrapLabel
    />
  );

  if (row.groupId === undefined) {
    return (
      <div className="flex w-full max-w-full flex-col items-start">
        {thought}
        {activity}
      </div>
    );
  }

  return (
    <button
      type="button"
      aria-expanded={row.expanded}
      // Named by its label alone. Unnamed, the button would take its name from its content, the
      // reasoning preview included, and that changes several times a second.
      aria-label={failed ? `${label}, tool call failed` : label}
      onClick={onToggle}
      className={`group/live-work flex w-full max-w-full cursor-pointer rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/70 ${
        row.thought !== undefined ? "flex-col items-start" : "min-h-6 items-center"
      }`}
    >
      {thought}
      {activity}
    </button>
  );
}

function formatWorkingTimer(started: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - started) / 1000));
  return seconds < 60 ? `${seconds}s` : formatDuration(seconds * 1_000);
}

/**
 * The clock, written straight into the DOM once a second through a ref. Nothing else in the row
 * changes, so a React render per tick would re-render the row — and with it everything the
 * timeline hands down to it — for one changed digit.
 */
function WorkingTimer({ startedAt }: { startedAt: string | undefined }) {
  const text = useRef<HTMLSpanElement>(null);
  // The pane hands down the earliest time it knows of (see `ChatPane`), and keeps it from going
  // back. It is followed even when it moves forward: this row survives from one turn into the
  // next, so a floor here would carry the last turn's count into the new one. When this appeared
  // is only for a caller that hands down nothing. Captured once: read each render, the anchor
  // would move with the clock and pin the count at zero.
  const [mountedAt] = useState(() => Date.now());
  const parsed = startedAt === undefined ? Number.NaN : Date.parse(startedAt);
  const anchor = Number.isFinite(parsed) ? parsed : mountedAt;

  useEffect(() => {
    const tick = () => {
      if (text.current !== null) text.current.textContent = formatWorkingTimer(anchor);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [anchor]);

  // The server's clock and the browser's disagree by however long the page took to arrive, and
  // the next tick corrects it either way.
  return (
    <span ref={text} className="tabular-nums" suppressHydrationWarning>
      {formatWorkingTimer(anchor)}
    </span>
  );
}

/**
 * "Working for 12s", under the prompt of the turn that is running. No spinner and no animation:
 * the live row at the bottom is what moves, and two moving things would compete for the eye.
 *
 * In the accessibility tree it is one static phrase. The clock changes every second, and a live
 * region carrying it would announce every second; the work itself is announced by the rows.
 */
export function WorkingRow({ startedAt }: { startedAt: string | undefined }) {
  return (
    <div role="status" aria-label="Agent is working" className="border-edge border-b pt-1 pb-2">
      <div
        aria-hidden="true"
        className="flex h-6 min-w-0 items-baseline gap-2 px-1 text-muted text-sm tabular-nums leading-relaxed"
      >
        <span className="relative shrink-0 overflow-hidden whitespace-nowrap">
          Working for <WorkingTimer startedAt={startedAt} />
        </span>
      </div>
    </div>
  );
}

/** A finished turn's work, folded: "Worked for 1m 12s", which opens back into the work. */
export function TurnFoldRow({
  row,
  onToggle,
}: {
  row: Extract<TimelineRow, { kind: "turn-fold" }>;
  onToggle: () => void;
}) {
  return (
    <div className="group/timeline-row relative flex items-center gap-1 border-edge/60 border-b pt-1 pe-0.5 pb-2">
      <button
        type="button"
        aria-expanded={row.expanded}
        onClick={onToggle}
        className="flex cursor-pointer select-none items-center gap-1 rounded-md px-1 text-muted text-sm tabular-nums leading-relaxed transition-colors hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/70"
      >
        <span>{row.label}</span>
        {row.expanded ? (
          <ChevronDown aria-hidden="true" className="size-3.5" />
        ) : (
          <ChevronRight aria-hidden="true" className="size-3.5" />
        )}
      </button>
      <Timestamp at={row.at} className="ms-auto" />
    </div>
  );
}
