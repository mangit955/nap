"use client";

import { type SessionSummary, sessionSection } from "@nap/shared/session-navigation";
import {
  AlarmClock,
  AlarmClockOff,
  Check,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  Clock,
  Ellipsis,
  FolderGit2,
  GitPullRequest,
  Pin,
  SquarePen,
  Undo2,
  X,
} from "lucide-react";
import {
  type KeyboardEvent,
  type MouseEvent,
  memo,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import { NapMark } from "../brand/nap-mark.tsx";
import {
  compactTime,
  diffLabel,
  modelLabel,
  type RowStatus,
  recedes,
  rowStatus,
  type SessionSource,
  type Shelf,
  sessionSource,
  snoozeWakeLabel,
  workingDuration,
} from "./session-rows.ts";
import { SnoozeMenu } from "./snooze-menu.tsx";

/**
 * One session in the sidebar, drawn as T3 Code draws a thread.
 *
 * A **card** (pinned and inbox rows) is three fixed lines: where the session came from and its
 * status, its title, and its branch and pull request. A **slim** row (the Snoozed and Settled
 * shelves) is one line. Both are a link to the session, and the controls that act on it sit
 * *beside* the link rather than in it — a button inside a link is two controls fighting over
 * one press.
 *
 * Adapted from T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.), `sidebar/SidebarThreadRow.tsx`.
 */
export type RowAction =
  /** Somebody looked at the session: opened it, or (`dismiss`) cleared its Woke on purpose. */
  | { kind: "seen"; projectId: string; dismiss?: boolean }
  | { kind: "settle"; projectId: string; value: boolean }
  /** Snooze until a time, or wake now with `null`. */
  | { kind: "snooze"; projectId: string; until: string | null }
  | { kind: "rename-start"; projectId: string }
  /** `name` is absent when the edit was abandoned. */
  | { kind: "rename-end"; projectId: string; name?: string | undefined }
  /** Open the context menu at a point — from the touch-only trigger, which has no right-click. */
  | { kind: "menu"; projectId: string; at: { x: number; y: number } };

export const SessionRow = memo(function SessionRow({
  session,
  shelf,
  isOpen,
  hasDraft,
  now,
  selected = false,
  renaming = false,
  jumpHint,
  canNavigate = false,
  canRename = false,
  hasMenu = false,
  dispatch,
  onSelectProject,
}: {
  session: SessionSummary;
  /** Which shelf the row is on. Pinned and inbox rows are cards; the shelves are slim rows. */
  shelf: Shelf;
  isOpen: boolean;
  /** Something is typed into this session's box and not sent. */
  hasDraft: boolean;
  now: number;
  /** Part of a multi-selection. */
  selected?: boolean;
  renaming?: boolean;
  /** The shortcut that opens this row, shown while its modifier is held. */
  jumpHint?: string | undefined;
  /** Whether the page can change where this row sits — settle, snooze, wake. */
  canNavigate?: boolean;
  canRename?: boolean;
  /** Whether the row has a context menu, and so a trigger for it where nothing can right-click. */
  hasMenu?: boolean;
  /**
   * Every action the row can take, through one function the list keeps stable — so a row
   * re-renders when its own session changes, not whenever the list does.
   */
  dispatch: (action: RowAction) => void;
  /** Handles a committed selection locally instead of following the project link. */
  onSelectProject?: ((projectId: string) => void) | undefined;
}) {
  const clickTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(clickTimer.current), []);
  const link = useRef<HTMLAnchorElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (!renaming && restoreFocus.current) {
      restoreFocus.current = false;
      link.current?.focus();
    }
  }, [renaming]);
  const [menuOpen, setMenuOpen] = useState(false);
  const { projectId } = session;
  const onOpen = () => dispatch({ kind: "seen", projectId });
  const onRename = canRename ? () => dispatch({ kind: "rename-start", projectId }) : undefined;
  const onSettle = canNavigate
    ? (value: boolean) => dispatch({ kind: "settle", projectId, value })
    : undefined;
  const onSnooze = canNavigate
    ? (until: string | null) => dispatch({ kind: "snooze", projectId, until })
    : undefined;
  const status = rowStatus(session, now);
  const woke = status?.kind === "woke";
  const source = sessionSource(session.repository);
  const quiet = recedes(status, isOpen);
  const working = status?.kind === "working" || status?.kind === "queued";
  const variant = shelf === "pinned" || shelf === "active" ? "card" : "slim";
  const section = sessionSection(session, now);
  const snoozed = section === "snoozed";
  const settled = section === "done";
  const href = `/p/${session.projectId}`;
  const surface = selected
    ? "bg-accent-tint"
    : isOpen
      ? "bg-row-active"
      : hasDraft
        ? "bg-warning/[0.04] hover:bg-warning/[0.08]"
        : "hover:bg-row-hover";
  // Said once, inside the link, so a screen reader hears it with the row's name.
  const selectedNote = selected ? <span className="sr-only">, selected</span> : null;
  const hint = jumpHint ? (
    <kbd className="rounded-[4px] bg-hover px-1 font-sans text-[11px] text-ink-2">{jumpHint}</kbd>
  ) : null;
  // T3 fades work in progress that is not open, so the eye goes to rows that want something.
  // Its menus are portaled out of the row, so an open one is matched by its trigger's
  // aria-expanded rather than by hover or focus, which have both left the row by then.
  const fade =
    quiet && working && variant === "card"
      ? "opacity-70 transition-opacity hover:opacity-100 focus-within:opacity-100 has-[[aria-expanded=true]]:opacity-100 motion-reduce:transition-none"
      : "";

  const title = renaming ? (
    <RenameField
      name={session.name}
      onDone={(name, keyboard) => {
        restoreFocus.current = keyboard;
        dispatch({
          kind: "rename-end",
          projectId,
          name: name !== undefined && name !== session.name ? name : undefined,
        });
      }}
    />
  ) : (
    <span
      className={`min-w-0 flex-1 truncate text-sm ${
        variant === "card"
          ? quiet
            ? "font-normal text-sidebar-label"
            : status === null
              ? "font-medium text-ink-2"
              : "font-medium text-ink"
          : isOpen
            ? "font-medium text-ink"
            : "font-normal text-sidebar-label group-hover:text-ink group-focus-within:text-ink"
      }`}
    >
      {session.name}
    </span>
  );

  // Double-click renames, as in T3. The link swallows the click that would otherwise navigate.
  const linkProps = {
    ref: link,
    href,
    "aria-current": isOpen ? ("page" as const) : undefined,
    "data-session-link": "",
    title: details(session, source),
    onClick: (event: MouseEvent<HTMLAnchorElement>) => {
      if (event.defaultPrevented) return;
      const modified =
        event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;
      if (!onRename || event.detail === 0 || modified) {
        onOpen();
        if (onSelectProject && !modified) {
          event.preventDefault();
          onSelectProject(session.projectId);
        }
        return;
      }
      event.preventDefault();
      clearTimeout(clickTimer.current);
      const anchor = event.currentTarget;
      clickTimer.current = setTimeout(() => anchor.click(), 300);
    },
    onDoubleClick: (event: MouseEvent) => {
      if (!onRename) return;
      event.preventDefault();
      clearTimeout(clickTimer.current);
      onRename();
    },
  };

  // Touch screens have no right-click, and iOS does not turn a long press on a link into one, so
  // they get a visible trigger for the same menu. `session-actions` keeps it, and the hover
  // controls around it, shown on touch only (`globals.css`, `hover: none`).
  const more = hasMenu ? (
    <button
      type="button"
      aria-label={`More actions for ${session.name}`}
      title="More actions"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        const rect = event.currentTarget.getBoundingClientRect();
        dispatch({ kind: "menu", projectId, at: { x: rect.right - 240, y: rect.bottom + 4 } });
      }}
      className="session-actions hidden size-5 shrink-0 place-items-center rounded-md text-muted hover:text-ink"
    >
      <Ellipsis aria-hidden className="size-3.5" />
    </button>
  ) : null;

  const hoverControls = `sidebar-row-controls pointer-events-none absolute right-1.5 flex items-center opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:opacity-100 ${menuOpen ? "pointer-events-auto opacity-100" : ""}`;

  if (variant === "slim") {
    const time = snoozed
      ? `in ${snoozeWakeLabel(session.navigation.snoozedUntil ?? "", now)}`
      : compactTime(session.navigation.doneAt ?? session.updatedAt, now);
    return (
      <div className="group relative">
        <div className={`relative flex h-9 items-center rounded-md ${surface}`}>
          {renaming ? (
            <div className="flex min-w-0 flex-1 items-center gap-2.5 px-2.5">{title}</div>
          ) : (
            <a
              {...linkProps}
              className={`${LINK} flex h-full min-w-0 flex-1 items-center gap-2.5 px-2.5`}
            >
              <span
                className={`flex shrink-0 transition ${isOpen ? "" : "opacity-40 grayscale group-hover:opacity-100 group-hover:grayscale-0"}`}
              >
                <SourceMark source={source} />
              </span>
              {hasDraft && <DraftMark />}
              {title}
              {selectedNote}
              <span
                className={`ml-auto shrink-0 text-xs tabular-nums transition-opacity group-hover:opacity-0 ${snoozed ? "text-info" : "text-sidebar-label"}`}
              >
                {hint ?? time}
              </span>
            </a>
          )}
          <span className={`${hoverControls} inset-y-0`}>
            {snoozed
              ? onSnooze && (
                  <RowButton label={`Wake ${session.name}`} onPress={() => onSnooze(null)}>
                    <AlarmClockOff aria-hidden className="size-3.5" />
                  </RowButton>
                )
              : onSettle && (
                  <RowButton label={`Un-settle ${session.name}`} onPress={() => onSettle(false)}>
                    <Undo2 aria-hidden className="size-3.5" />
                  </RowButton>
                )}
            {more}
          </span>
        </div>
      </div>
    );
  }

  const inner = (
    <>
      <span className="flex h-5 min-w-0 items-center gap-1.5">
        {hasDraft && <DraftMark />}
        <SourceMark source={source} />
        {session.navigation.pinned && (
          <Pin aria-label="Pinned" role="img" className="size-3 shrink-0 text-muted" />
        )}
        <span
          className={`min-w-0 flex-1 truncate text-xs text-sidebar-label ${quiet ? "font-normal" : "font-medium"}`}
        >
          {source.label}
        </span>
        <span
          className={`ml-auto flex shrink-0 items-center text-xs tabular-nums text-sidebar-label transition-opacity ${
            onSettle || onSnooze ? "group-hover:opacity-0 group-has-[:focus-visible]:opacity-0" : ""
          } ${menuOpen ? "opacity-0" : ""}`}
        >
          {hint ?? (
            <StatusSlot
              status={status}
              timestamp={session.requestedAt ?? session.updatedAt}
              now={now}
            />
          )}
        </span>
      </span>
      <span className="mt-1 flex min-w-0">
        {title}
        {selectedNote}
      </span>
      <span className="mt-0.5 flex h-4 min-w-0 items-center gap-1.5 text-xs text-sidebar-label">
        {session.branch ? (
          <>
            <FolderGit2 aria-hidden className="size-3 shrink-0 text-muted/40" />
            <span className="flex min-w-0 flex-1 text-muted/45" title={session.branch}>
              <span className="truncate">{session.branch.slice(0, -12)}</span>
              <span className="shrink-0">{session.branch.slice(-12)}</span>
            </span>
          </>
        ) : (
          <span className="flex-1" />
        )}
        {session.pullRequest && (
          <span
            className={`inline-flex shrink-0 items-center gap-1 ${PR_COLOUR[session.pullRequest.state]}`}
            title={`${session.pullRequest.state} pull request`}
          >
            <GitPullRequest aria-hidden className="size-3" />#{session.pullRequest.number}
            <span className="sr-only"> {session.pullRequest.state}</span>
          </span>
        )}
        {session.pendingFeedback > 0 && (
          <span className="shrink-0 text-ink-2">{session.pendingFeedback} feedback</span>
        )}
        <CardFacts session={session} />
      </span>
    </>
  );

  return (
    <div className="group relative py-0.5">
      <div className={`relative h-[4.875rem] rounded-md ${surface} ${fade}`}>
        {renaming ? (
          <div className="flex h-full flex-col px-2.5 py-2">{inner}</div>
        ) : (
          <a {...linkProps} className={`${LINK} flex h-full flex-col px-2.5 py-2`}>
            {inner}
          </a>
        )}
        {!working && (onSettle || onSnooze) && (
          <span className={`${hoverControls} top-2 h-5`}>
            {woke && (
              // The Woke chip again, now a button: hovering is the moment it can be dismissed.
              <RowButton
                label={`Dismiss Woke for ${session.name}`}
                onPress={() => dispatch({ kind: "seen", projectId, dismiss: true })}
              >
                <X aria-hidden className="size-3.5" />
                <span aria-hidden className="text-info">
                  Woke
                </span>
              </RowButton>
            )}
            {onSnooze &&
              !woke &&
              (snoozed ? (
                <RowButton label={`Wake ${session.name}`} onPress={() => onSnooze(null)}>
                  <AlarmClockOff aria-hidden className="size-3.5" />
                </RowButton>
              ) : (
                <SnoozeMenu
                  name={session.name}
                  onSnooze={(until) => onSnooze(until)}
                  onOpenChange={setMenuOpen}
                />
              ))}
            {onSettle && (
              <RowButton
                label={`${settled ? "Un-settle" : "Settle"} ${session.name}`}
                onPress={() => onSettle(!settled)}
              >
                {settled ? (
                  <Undo2 aria-hidden className="size-3.5" />
                ) : (
                  <Check aria-hidden className="size-3.5" />
                )}
                <span aria-hidden>{settled ? "Un-settle" : "Settle"}</span>
              </RowButton>
            )}
          </span>
        )}
        {more && <span className={`${hoverControls} bottom-2 h-5`}>{more}</span>}
      </div>
    </div>
  );
});

const LINK =
  "rounded-md outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent";

const PR_COLOUR = {
  open: "text-success",
  merged: "text-[#a78bfa]",
  closed: "text-muted",
} as const;

/** What T3 shows in a hover card, as a native tooltip: where the work is and what it is doing. */
function details(session: SessionSummary, source: SessionSource): string {
  const workspace = session.sandboxId
    ? "Workspace running"
    : session.status === "creating"
      ? "Workspace pending"
      : "Workspace put away";
  return [session.name, session.repository ?? source.label, session.branch, workspace]
    .filter((part): part is string => !!part)
    .join(" · ");
}

function StatusSlot({
  status,
  timestamp,
  now,
}: {
  status: RowStatus | null;
  timestamp: string;
  now: number;
}) {
  if (status === null) return <span>{compactTime(timestamp, now)}</span>;
  if (status.kind === "queued")
    return (
      <span className="inline-flex items-center gap-1 font-medium text-info">
        <Clock aria-hidden className="size-4 shrink-0" />
        <span role="status">Queued</span>
      </span>
    );
  if (status.kind === "working")
    return (
      <span className="inline-flex items-center gap-1 font-medium text-info">
        <CircleDashed aria-hidden className="size-4 shrink-0" />
        <span role="status">Working</span>
        {status.since && <Elapsed since={status.since} />}
      </span>
    );
  if (status.kind === "failed")
    return (
      <span className="inline-flex items-center gap-1 font-medium text-danger">
        <CircleAlert aria-hidden className="size-4 shrink-0" />
        <span role="status">Failed</span>
      </span>
    );
  if (status.kind === "woke")
    return (
      <span className="inline-flex items-center gap-1 font-medium text-info">
        <AlarmClock aria-hidden className="size-4 shrink-0" />
        <span role="status">Woke</span>
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 font-medium text-success">
      <CircleCheck aria-hidden className="size-4 shrink-0" />
      <span role="status">Done</span>
    </span>
  );
}

/**
 * The end of the card's third line: what the newest committed turn changed, and the model the
 * newest turn ran on. Each is left out rather than guessed when the API did not say.
 */
function CardFacts({ session }: { session: SessionSummary }) {
  const diff = diffLabel(session.diff);
  const model = modelLabel(session.model);
  return (
    <>
      {diff && (
        <span className="shrink-0 tabular-nums" title="Lines changed by the latest commit">
          <span className="text-success">{diff.added}</span>{" "}
          <span className="text-danger">{diff.removed}</span>
        </span>
      )}
      {model && (
        <span className="max-w-24 shrink-0 truncate text-muted/70" title={session.model ?? ""}>
          {model}
        </span>
      )}
    </>
  );
}

/**
 * The running clock beside *Working*. Ticks on its own, so a second passing re-renders this
 * span and not the list. `aria-hidden`: a live region around a clock announces every second.
 */
function Elapsed({ since }: { since: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span aria-hidden>{now === null ? "" : workingDuration(now - Date.parse(since))}</span>;
}

/** The repository owner's avatar, or the Nap mark for a session that came from no repository. */
export function SourceMark({ source }: { source: SessionSource }) {
  const [failed, setFailed] = useState(false);
  if (source.owner === null || failed)
    return source.owner === null ? (
      <NapMark aria-hidden className="size-4 shrink-0 rounded-[4px]" />
    ) : (
      <span
        aria-hidden
        className="grid size-4 shrink-0 place-items-center rounded-[4px] bg-hover text-[9px] font-semibold text-ink-2 uppercase"
      >
        {source.label.slice(0, 1)}
      </span>
    );
  return (
    // biome-ignore lint/performance/noImgElement: a 16px avatar from GitHub needs no image pipeline.
    <img
      src={`https://github.com/${encodeURIComponent(source.owner)}.png?size=32`}
      alt=""
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className="size-4 shrink-0 rounded-[4px] object-cover"
    />
  );
}

function DraftMark() {
  return (
    <SquarePen aria-label="Unsent draft" role="img" className="size-3 shrink-0 text-warning" />
  );
}

function RowButton({
  label,
  onPress,
  children,
}: {
  label: string;
  onPress: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onPress();
      }}
      className="inline-flex h-5 cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs text-muted hover:text-ink focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40"
    >
      {children}
    </button>
  );
}

/** T3's in-place rename: Enter or leaving the field keeps it, Escape puts it back. */
function RenameField({
  name,
  onDone,
}: {
  name: string;
  onDone: (name: string | undefined, keyboard: boolean) => void;
}) {
  const [value, setValue] = useState(name);
  const commit = (keyboard: boolean) => {
    const trimmed = value.trim();
    onDone(trimmed && trimmed.length <= 60 ? trimmed : undefined, keyboard);
  };
  return (
    <input
      // biome-ignore lint/a11y/noAutofocus: the field exists only because somebody asked to type in it.
      autoFocus
      aria-label="Session name"
      value={value}
      maxLength={60}
      onChange={(event) => setValue(event.target.value)}
      onFocus={(event) => event.currentTarget.select()}
      onBlur={() => commit(false)}
      onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
        event.stopPropagation();
        if (event.nativeEvent.isComposing) return;
        if (event.key === "Enter") {
          event.preventDefault();
          commit(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          setValue(name);
          onDone(undefined, true);
        }
      }}
      className="min-w-0 flex-1 rounded-sm border border-edge bg-field px-1 text-sm font-medium text-ink outline-none focus:border-ink-2"
    />
  );
}
