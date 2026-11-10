"use client";

import { type SessionSummary, sessionSection } from "@nap/shared/session-navigation";
import { ChevronDown, X } from "lucide-react";
import {
  type ComponentType,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ApplyOptions, NavigationStep } from "../projects/use-session-navigation.ts";
import { SessionContextMenu } from "./session-context-menu.tsx";
import { SessionDialog, type SessionDialogRequest } from "./session-dialog.tsx";
import { type MenuItemId, sessionMenuItems } from "./session-menu.ts";
import { type RowAction, SessionRow } from "./session-row.tsx";
import {
  rangeBetween,
  SETTLED_PAGE,
  SETTLED_START,
  type Shelf,
  seenChange,
  sessionSource,
  shelveSessions,
  snoozePresets,
} from "./session-rows.ts";
import {
  type DropShelf,
  dropTarget,
  type ListItem,
  markerId,
  mergeOrder,
  planDrop,
} from "./sidebar-drop.ts";
import {
  adjacentId,
  isMacPlatform,
  opensMenu,
  shortcutCommand,
  showsJumpHints,
} from "./sidebar-keys.ts";

type DragModule = typeof import("./sidebar-drag.tsx");
type ShellProps = {
  id: string;
  marker?: boolean;
  disabled?: boolean;
  as?: "li" | "div";
  className?: string;
  children?: ReactNode;
};

/** A row's `<li>` before the drag layer has loaded, or where nothing can be dragged. */
function PlainShell({ id, marker, as: Element = "li", className, children }: ShellProps) {
  return (
    <Element data-row-id={marker ? undefined : id} className={className}>
      {children}
    </Element>
  );
}

let dragModule: DragModule | undefined;
let dragLoading: Promise<DragModule> | undefined;

/**
 * Starts fetching the drag layer. The sidebar calls this while its list is still loading, so the
 * layer is usually here before the first row is drawn and the rows never have to change shell.
 */
export function preloadDrag(): Promise<DragModule> {
  dragLoading ??= import("./sidebar-drag.tsx").then((module) => {
    dragModule = module;
    return module;
  });
  return dragLoading;
}

const NO_SELECTION: ReadonlySet<string> = new Set();
const SHELF_HEADERS: ReadonlySet<string> = new Set([
  markerId("snoozed-header"),
  markerId("settled-header"),
]);
/** How long the modifier is held before the jump hints show — T3's, so a quick ⌘C shows none. */
const HINT_DELAY_MS = 200;

/**
 * The session sidebar's list: one inbox, with Snoozed and Settled as shelves at the bottom.
 *
 * Every way of acting on a row — its hover buttons, the context menu, a drag, a shortcut, the
 * bulk bar — ends in the same few functions here, and those hand the server one list of
 * `NavigationStep`s through `onApply`. The navigation hook draws those steps at once and puts
 * them back if the server refuses, so nothing in this file waits on a request.
 *
 * Rows are memoised and take one stable `dispatch`, so a key press, a hover or a pointer move
 * re-renders the row it concerns rather than all of them. Arrow keys move focus between the
 * rows' links without touching state at all.
 */
export function SessionList({
  draftIds,
  sessions,
  activeProjectId,
  query,
  repository,
  onRepositoryChange,
  ownerId,
  onApply,
  onRename,
  onRegenerateTitle,
  onDelete,
  onClose,
  onSelectProject,
  onLayout,
}: {
  onLayout?: ((selected: HTMLAnchorElement | null) => void) | undefined;
  draftIds?: ReadonlySet<string> | undefined;
  sessions: readonly SessionSummary[];
  activeProjectId?: string | undefined;
  query: string;
  repository: string;
  /** Lets "Filter by this source" set the sidebar's source filter. */
  onRepositoryChange?: ((key: string) => void) | undefined;
  ownerId?: string | undefined;
  /** Where every navigation change goes. Without it the list is for looking at only. */
  onApply?: ((steps: NavigationStep[], options?: ApplyOptions) => Promise<boolean>) | undefined;
  onRename?: ((id: string, name: string) => void) | undefined;
  /** Asks a model for the session's title; the row is dimmed until it lands. */
  onRegenerateTitle?: ((id: string) => void) | undefined;
  onDelete?: ((id: string) => void) | undefined;
  onClose?: ((id: string) => void) | undefined;
  onSelectProject?: ((projectId: string) => void) | undefined;
}) {
  const live = onApply !== undefined;
  const [now, setNow] = useState(Date.now);
  const [expanded, setExpanded] = useState({ snoozed: false, settled: false });
  const [settledCount, setSettledCount] = useState(SETTLED_START);
  const [restoredKey, setRestoredKey] = useState<string>();
  const storageKey = `nap.sidebar.shelves.${ownerId ?? "local"}`;
  useEffect(() => {
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(storageKey) ?? "null");
      setExpanded({
        snoozed:
          typeof stored === "object" &&
          stored !== null &&
          "snoozed" in stored &&
          stored.snoozed === true,
        settled:
          typeof stored === "object" &&
          stored !== null &&
          "settled" in stored &&
          stored.settled === true,
      });
    } catch {
      setExpanded({ snoozed: false, settled: false });
    }
    setRestoredKey(storageKey);
  }, [storageKey]);
  const toggle = (shelf: "snoozed" | "settled") => {
    const next = { ...expanded, [shelf]: !expanded[shelf] };
    setExpanded(next);
    try {
      localStorage.setItem(storageKey, JSON.stringify(next));
    } catch {
      /* Optional preference. */
    }
  };
  const [menu, setMenu] = useState<{ projectId: string; at: { x: number; y: number } }>();
  const [renamingId, setRenamingId] = useState<string>();
  const [dialog, setDialog] = useState<SessionDialogRequest>();
  const [selection, setSelection] = useState<ReadonlySet<string>>(NO_SELECTION);
  const anchor = useRef<string>(undefined);
  const [hints, setHints] = useState(false);
  const [dragging, setDragging] = useState<string>();
  const [dropShelf, setDropShelf] = useState<DropShelf>();
  const [notice, setNotice] = useState<{ alert: boolean; text: string }>();
  const [drag, setDrag] = useState<DragModule | undefined>(dragModule);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!live || drag) return;
    let cancelled = false;
    void preloadDrag().then((module) => {
      if (cancelled) return;
      // Arriving after the rows, the layer swaps their shell and so remounts them; whoever had
      // a row focused keeps it.
      const focused = document.activeElement?.closest<HTMLElement>("[data-row-id]")?.dataset.rowId;
      refocus.current = focused;
      setDrag(module);
    });
    return () => {
      cancelled = true;
    };
  }, [live, drag]);
  const refocus = useRef<string>(undefined);
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs once, when the drag layer arrives.
  useLayoutEffect(() => {
    const id = refocus.current;
    refocus.current = undefined;
    if (id && drag) linkFor(id)?.focus();
  }, [drag]);
  useEffect(() => {
    if (!notice || notice.alert) return;
    const timer = setTimeout(() => setNotice(undefined), 2000);
    return () => clearTimeout(timer);
  }, [notice]);

  const { sorted, filtered, drawn, anyMatch, byId } = useMemo(() => {
    const shelves = shelveSessions(sessions, now);
    const sorted = [...shelves.pinned, ...shelves.active, ...shelves.snoozed, ...shelves.settled];
    const needle = query.trim().toLowerCase();
    const matches = (row: SessionSummary) =>
      (!repository || sessionSource(row.repository).key === repository) &&
      row.name.toLowerCase().includes(needle);
    const filtered = shelveSessions(sorted.filter(matches), now);
    const drawn = [
      ...filtered.pinned,
      ...filtered.active,
      ...(expanded.snoozed ? filtered.snoozed : []),
      ...(expanded.settled ? filtered.settled.slice(0, settledCount) : []),
    ];
    return {
      sorted,
      filtered,
      drawn,
      anyMatch: sorted.some(matches),
      byId: new Map(sessions.map((row) => [row.projectId, row])),
    };
  }, [sessions, now, query, repository, expanded, settledCount]);
  const selectedOutside = sorted.find(
    (row) => row.projectId === activeProjectId && !drawn.includes(row),
  );
  /** Top to bottom, as the eye and the keyboard meet them. */
  const order = useMemo(
    () => [...(selectedOutside ? [selectedOutside] : []), ...drawn].map((row) => row.projectId),
    [selectedOutside, drawn],
  );
  const selected = drawn.find((row) => row.projectId === activeProjectId);
  const selectedPlacement = selectedOutside ? "current" : selected && sessionSection(selected, now);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reveal when selection changes placement, never on a polling-only render.
  useEffect(() => {
    if (restoredKey === storageKey) {
      onLayout?.(root.current?.querySelector<HTMLAnchorElement>('a[aria-current="page"]') ?? null);
    }
  }, [onLayout, restoredKey, storageKey, activeProjectId, selectedPlacement]);
  /** The selection, minus rows that have since gone from view. */
  const selectedIds = order.filter((id) => selection.has(id));

  const linkFor = (id: string) =>
    root.current?.querySelector<HTMLAnchorElement>(
      `[data-row-id="${CSS.escape(id)}"] a[data-session-link]`,
    ) ?? null;

  // ——— The actions. Everything that changes a row comes through here. ———

  const apply = (steps: NavigationStep[], options?: ApplyOptions) => {
    if (!onApply || steps.length === 0) return;
    void (options ? onApply(steps, options) : onApply(steps));
  };
  const working = (row: SessionSummary) => row.activity === "working" || row.activity === "queued";
  const rowsFor = (ids: readonly string[]) =>
    ids.flatMap((id) => {
      const row = byId.get(id);
      return row ? [row] : [];
    });
  const counted = (verb: string, count: number) => (count > 1 ? `${verb} ${count} sessions` : verb);
  const changeEach = (
    rows: readonly SessionSummary[],
    change: (row: SessionSummary) => NavigationStep | null,
    verb: string,
  ) => {
    const steps = rows.flatMap((row) => {
      const step = change(row);
      return step ? [step] : [];
    });
    apply(steps, { label: counted(verb, steps.length) });
  };
  const actions = {
    pin(row: SessionSummary, pinned: boolean) {
      changeEach(
        [row],
        () => ({ kind: "change", projectId: row.projectId, change: { kind: "pin", pinned } }),
        pinned ? "Pinned" : "Unpinned",
      );
    },
    settle(ids: readonly string[], value: boolean) {
      changeEach(
        rowsFor(ids),
        (row) =>
          (sessionSection(row, now) === "done") === value || (value && working(row))
            ? null
            : { kind: "change", projectId: row.projectId, change: { kind: "done", value } },
        value ? "Settled" : "Un-settled",
      );
    },
    snooze(ids: readonly string[], until: string | null) {
      changeEach(
        rowsFor(ids),
        (row) =>
          until !== null && working(row)
            ? null
            : { kind: "change", projectId: row.projectId, change: { kind: "snooze", until } },
        until === null ? "Woken" : "Snoozed",
      );
    },
    archive(ids: readonly string[]) {
      changeEach(
        rowsFor(ids),
        (row) =>
          working(row)
            ? null
            : {
                kind: "change",
                projectId: row.projectId,
                change: { kind: "archive", value: true },
              },
        "Archived",
      );
    },
    markUnread(row: SessionSummary, unread: boolean) {
      apply([
        {
          kind: "change",
          projectId: row.projectId,
          // The later of the two, so marking read covers the finished turn that made it Done.
          change: {
            kind: "read",
            at:
              row.turnFinishedAt !== null &&
              (row.activityAt === null || row.turnFinishedAt > row.activityAt)
                ? row.turnFinishedAt
                : row.activityAt,
            unread,
          },
        },
      ]);
    },
    seen(row: SessionSummary, quiet: boolean) {
      const change = seenChange(row, Date.now());
      if (change) apply([{ kind: "change", projectId: row.projectId, change }], { quiet });
    },
    remove(ids: readonly string[]) {
      for (const id of ids) onDelete?.(id);
    },
    async copy(text: string, what: string) {
      try {
        await navigator.clipboard.writeText(text);
        setNotice({ alert: false, text: `${what} copied` });
      } catch {
        setNotice({ alert: true, text: "Could not copy. Check clipboard access and try again." });
      }
    },
  };

  /** The drawn neighbours on a row's own shelf, which Move up and Move down swap it with. */
  const neighbours = (row: SessionSummary) => {
    const section = sessionSection(row, now);
    const shelf: Shelf =
      section === "done" ? "settled" : section === "archived" ? "active" : section;
    const group = filtered[shelf].map((item) => item.projectId);
    const index = group.indexOf(row.projectId);
    return { shelf, section, group, index };
  };
  const move = (row: SessionSummary, by: 1 | -1) => {
    const { shelf, section, group, index } = neighbours(row);
    const other = group[index + by];
    if (index < 0 || other === undefined) return;
    const drawnOrder = [...group];
    drawnOrder[index] = other;
    drawnOrder[index + by] = row.projectId;
    const full = shelveSessions(sessions, now)[shelf].map((item) => item.projectId);
    apply([{ kind: "reorder", section, projectIds: mergeOrder(full, drawnOrder, row.projectId) }]);
  };

  const chooseFromMenu = (id: MenuItemId, row: SessionSummary) => {
    const ids = [row.projectId];
    switch (id) {
      case "pin":
      case "unpin":
        return actions.pin(row, id === "pin");
      case "settle":
      case "unsettle":
        return actions.settle(ids, id === "settle");
      case "wake":
        return actions.snooze(ids, null);
      case "move-up":
      case "move-down":
        return move(row, id === "move-up" ? -1 : 1);
      case "snooze:custom":
        return setDialog({ kind: "snooze", ids, names: [row.name] });
      case "rename":
        return setRenamingId(row.projectId);
      case "regenerate-title":
        return onRegenerateTitle?.(row.projectId);
      case "mark-unread":
      case "mark-read":
        return actions.markUnread(row, id === "mark-unread");
      case "filter-source":
        return onRepositoryChange?.(sessionSource(row.repository).key);
      case "show-all-sources":
        return onRepositoryChange?.("");
      case "copy-link":
        return void actions.copy(`${window.location.origin}/p/${row.projectId}`, "Session link");
      case "copy-branch":
        return void actions.copy(row.branch ?? "", "Branch");
      case "put-away":
        return onClose?.(row.projectId);
      case "archive":
        return actions.archive(ids);
      case "delete":
        return setDialog({ kind: "delete", ids, names: [row.name] });
      case "snooze":
      case "copy":
        return;
      default: {
        const preset = snoozePresets(new Date()).find((item) => `snooze:${item.id}` === id);
        if (preset) actions.snooze(ids, preset.snoozedUntil);
      }
    }
  };

  // A row's every action goes through one function that never changes, so rows can be memoised.
  const latest = useRef({ actions, byId, onRename });
  latest.current = { actions, byId, onRename };
  const dispatch = useCallback((action: RowAction) => {
    const { actions, byId, onRename } = latest.current;
    const row = byId.get(action.projectId);
    if (!row) return;
    switch (action.kind) {
      case "seen":
        // Opening a row acknowledges it in passing; only dismissing Woke is asked for out loud.
        return actions.seen(row, !action.dismiss);
      case "settle":
        return actions.settle([row.projectId], action.value);
      case "snooze":
        return actions.snooze([row.projectId], action.until);
      case "rename-start":
        return setRenamingId(row.projectId);
      case "rename-end":
        setRenamingId(undefined);
        if (action.name !== undefined) onRename?.(row.projectId, action.name);
        return;
      case "menu":
        return setMenu({ projectId: row.projectId, at: action.at });
    }
  }, []);
  const openRef = useRef(onSelectProject);
  openRef.current = onSelectProject;
  const hasSelect = onSelectProject !== undefined;
  const selectProject = useMemo(
    () => (hasSelect ? (id: string) => openRef.current?.(id) : undefined),
    [hasSelect],
  );

  // ——— Keyboard shortcuts: jump with ⌘1–9, step with ⌘⇧] and ⌘⇧[. ———

  const orderRef = useRef(order);
  orderRef.current = order;
  const activeRef = useRef(activeProjectId);
  activeRef.current = activeProjectId;
  const mac = useMemo(isMacPlatform, []);
  // A layout effect, so the shortcuts listen from the commit that draws the rows. A passive
  // effect after a commit that no event caused (the first page of sessions arriving) runs on a
  // later task, and a key pressed in between found rows on screen and nothing listening.
  useLayoutEffect(() => {
    if (!live) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hide = () => {
      clearTimeout(timer);
      timer = undefined;
      setHints(false);
    };
    const open = (id: string | undefined) => {
      if (!id) return false;
      const link = root.current?.querySelector<HTMLAnchorElement>(
        `[data-row-id="${CSS.escape(id)}"] a[data-session-link]`,
      );
      link?.click();
      return !!link;
    };
    const down = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      const command = shortcutCommand(event, mac);
      if (command) {
        hide();
        const id =
          command.kind === "jump"
            ? orderRef.current[command.index]
            : adjacentId(orderRef.current, activeRef.current, command.direction);
        if (open(id)) event.preventDefault();
        return;
      }
      if (showsJumpHints(event, mac)) {
        timer ??= setTimeout(() => setHints(true), HINT_DELAY_MS);
      } else hide();
    };
    const up = (event: KeyboardEvent) => {
      if (!showsJumpHints(event, mac)) hide();
    };
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    window.addEventListener("blur", hide);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
      window.removeEventListener("blur", hide);
    };
  }, [live, mac]);

  // ——— Rows animate to where an action put them. ———

  const positions = useRef(new Map<string, number>());
  const measure = () => {
    const next = new Map<string, number>();
    const element = root.current;
    if (!element) return next;
    const top = element.getBoundingClientRect().top;
    for (const row of element.querySelectorAll<HTMLElement>("[data-row-id]"))
      if (row.dataset.rowId) next.set(row.dataset.rowId, row.getBoundingClientRect().top - top);
    return next;
  };
  const layoutKey = `${order.join()}|${dragging ? "drag" : ""}|${expanded.snoozed}${expanded.settled}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs when the drawn order changes, which `layoutKey` names.
  useLayoutEffect(() => {
    // Runs as a drag starts (the boundaries open the list up) and as it ends; in between the
    // key holds still, and the sortable list moves rows itself.
    const previous = positions.current;
    const next = measure();
    positions.current = next;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    for (const [id, top] of next) {
      const before = previous.get(id);
      const element = root.current?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(id)}"]`);
      if (before === undefined || Math.abs(before - top) < 1 || !element?.animate) continue;
      element.animate(
        [{ transform: `translateY(${before - top}px)` }, { transform: "translateY(0)" }],
        { duration: 180, easing: "cubic-bezier(0.2, 0, 0, 1)" },
      );
    }
  }, [layoutKey]);

  // ——— Dragging between shelves. ———

  const items = useMemo((): ListItem[] => {
    const rows = (group: readonly SessionSummary[]) =>
      group.map((row): ListItem => ({ kind: "row", id: row.projectId }));
    return [
      { kind: "marker", marker: "pinned-header" },
      ...rows(filtered.pinned),
      { kind: "marker", marker: "pinned-divider" },
      ...rows(filtered.active),
      ...(filtered.snoozed.length
        ? [
            { kind: "marker", marker: "snoozed-header" } as const,
            ...rows(expanded.snoozed ? filtered.snoozed : []),
          ]
        : []),
      { kind: "marker", marker: "settled-header" },
      ...rows(expanded.settled ? filtered.settled.slice(0, settledCount) : []),
    ];
  }, [filtered, expanded, settledCount]);
  const itemIds = useMemo(
    () => items.map((item) => (item.kind === "row" ? item.id : markerId(item.marker))),
    [items],
  );
  const onDragStart = (id: string) => {
    setMenu(undefined);
    setDragging(id);
  };
  const onDragOver = (id: string, overId: string | undefined) => {
    setDropShelf(overId === undefined ? undefined : dropTarget(items, id, overId)?.shelf);
  };
  const onDragEnd = (id: string, overId: string | undefined) => {
    // Where each row is drawn right now, transforms included, so the settle animates from there.
    positions.current = measure();
    setDragging(undefined);
    setDropShelf(undefined);
    const row = byId.get(id);
    const target = overId === undefined ? null : dropTarget(items, id, overId);
    if (!row || !target) return;
    const steps = planDrop(sessions, row, target, now);
    const pinned = target.shelf === "pinned";
    const from = sessionSection(row, now);
    const verb =
      target.shelf === "settled"
        ? "Settled"
        : from === "done"
          ? "Un-settled"
          : from === "snoozed"
            ? "Woken"
            : pinned && from !== "pinned"
              ? "Pinned"
              : !pinned && from === "pinned"
                ? "Unpinned"
                : undefined;
    apply(steps, { label: verb });
  };

  // ——— Drawing. ———

  const Shell: ComponentType<ShellProps> = drag?.SortableShell ?? PlainShell;
  const canNavigate = live;
  const canRename = onRename !== undefined;
  const hasMenu =
    live ||
    canRename ||
    onRegenerateTitle !== undefined ||
    onDelete !== undefined ||
    onClose !== undefined;
  const renderRow = (row: SessionSummary, shelf: Shelf, sortable = true) => {
    const index = order.indexOf(row.projectId);
    const jumpHint =
      hints && index >= 0 && index < 9 ? `${mac ? "⌘" : "Ctrl "}${index + 1}` : undefined;
    const content = (
      <SessionRow
        session={row}
        shelf={shelf}
        isOpen={row.projectId === activeProjectId}
        hasDraft={draftIds?.has(row.projectId) ?? false}
        now={now}
        selected={selection.has(row.projectId)}
        renaming={renamingId === row.projectId}
        jumpHint={jumpHint}
        canNavigate={canNavigate}
        canRename={canRename}
        hasMenu={hasMenu}
        dispatch={dispatch}
        onSelectProject={selectProject}
      />
    );
    return sortable ? (
      <Shell
        key={row.projectId}
        id={row.projectId}
        disabled={renamingId === row.projectId}
        className="list-none"
      >
        {content}
      </Shell>
    ) : (
      <PlainShell key={row.projectId} id={row.projectId} className="list-none">
        {content}
      </PlainShell>
    );
  };
  const boundary = (marker: "pinned-header" | "pinned-divider", label: string, shelf: DropShelf) =>
    drag ? (
      <Shell key={marker} id={markerId(marker)} marker className="list-none">
        {dragging && (
          <div
            data-boundary={marker}
            className="flex h-7 items-center gap-2 px-2 text-xs font-medium"
            aria-hidden
          >
            <span className={dropShelf === shelf ? "text-accent-ink" : "text-muted"}>{label}</span>
            <span
              className={`h-px flex-1 ${dropShelf === shelf ? "bg-accent/60" : "bg-line-strong"}`}
            />
          </div>
        )}
      </Shell>
    ) : null;

  const menuRow = menu ? byId.get(menu.projectId) : undefined;
  const closeMenu = (restoreFocus: boolean) => {
    const id = menu?.projectId;
    setMenu(undefined);
    if (restoreFocus && id) linkFor(id)?.focus();
  };
  const openMenuFor = (id: string, at: { x: number; y: number }) => {
    if (!hasMenu) return;
    setMenu({ projectId: id, at });
  };

  const list = (
    // biome-ignore lint/a11y/noStaticElementInteractions: delegates keys, clicks and right-clicks from the rows inside it.
    <div
      ref={root}
      // `overflow-clip`: a dragged row is moved by a transform, and a transform past the list's
      // edge would otherwise grow the scroller's overflow — which auto-scroll then chases, and
      // the list runs away under the pointer. Clip is not a scroll container, so sticky still
      // sticks to the scroller outside; `relative` because anything that clips must be
      // (docs/GOTCHAS.md, Web and UI).
      className="relative flex min-h-full flex-col overflow-clip"
      onContextMenu={(event) => {
        if (event.target instanceof HTMLInputElement) return;
        const row = (event.target as HTMLElement).closest<HTMLElement>("[data-row-id]");
        if (!row?.dataset.rowId) return;
        event.preventDefault();
        openMenuFor(row.dataset.rowId, { x: event.clientX, y: event.clientY });
      }}
      onClickCapture={(event: MouseEvent<HTMLDivElement>) => {
        if (!live) return;
        const link = (event.target as HTMLElement).closest<HTMLElement>("a[data-session-link]");
        const id = link?.closest<HTMLElement>("[data-row-id]")?.dataset.rowId;
        if (!id) return;
        const toggles = mac ? event.metaKey : event.ctrlKey;
        if (toggles || event.shiftKey) {
          // ⌘/Ctrl-click adds or removes one row; Shift-click takes the run from the last one.
          event.preventDefault();
          event.stopPropagation();
          setSelection((current) => {
            const next = new Set(current);
            if (event.shiftKey && anchor.current)
              for (const each of rangeBetween(orderRef.current, anchor.current, id)) next.add(each);
            else if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
          });
          if (!event.shiftKey) anchor.current = id;
          return;
        }
        if (selection.size > 0) setSelection(NO_SELECTION);
        anchor.current = id;
      }}
      onKeyDown={(event) => {
        const target = event.target;
        if (event.key === "Escape" && selection.size > 0) {
          setSelection(NO_SELECTION);
          return;
        }
        if (!(target instanceof HTMLAnchorElement) || !target.hasAttribute("data-session-link"))
          return;
        if (opensMenu(event)) {
          const id = target.closest<HTMLElement>("[data-row-id]")?.dataset.rowId;
          if (!id) return;
          event.preventDefault();
          const rect = target.getBoundingClientRect();
          openMenuFor(id, { x: rect.left + 12, y: rect.top + rect.height / 2 });
          return;
        }
        if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        const links = [
          ...event.currentTarget.querySelectorAll<HTMLAnchorElement>("a[data-session-link]"),
        ];
        const index = links.indexOf(target);
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? links.length - 1
              : index + (event.key === "ArrowDown" ? 1 : -1);
        event.preventDefault();
        links[Math.max(0, Math.min(links.length - 1, next))]?.focus();
      }}
    >
      {selectedIds.length > 0 && (
        <BulkBar
          count={selectedIds.length}
          canSettle={rowsFor(selectedIds).some(
            (row) => !working(row) && sessionSection(row, now) !== "done",
          )}
          canPark={rowsFor(selectedIds).some((row) => !working(row))}
          canDelete={onDelete !== undefined && rowsFor(selectedIds).some((row) => !working(row))}
          onSettle={() => {
            actions.settle(selectedIds, true);
            setSelection(NO_SELECTION);
          }}
          onArchive={() => {
            actions.archive(selectedIds);
            setSelection(NO_SELECTION);
          }}
          onDelete={() => {
            const rows = rowsFor(selectedIds).filter((row) => !working(row));
            setDialog({
              kind: "delete",
              ids: rows.map((row) => row.projectId),
              names: rows.map((row) => row.name),
            });
          }}
          onClear={() => setSelection(NO_SELECTION)}
        />
      )}
      {selectedOutside && (
        <ul aria-label="Current session">{renderRow(selectedOutside, "active", false)}</ul>
      )}
      <ul aria-label="Inbox sessions">
        {boundary("pinned-header", "Pinned", "pinned")}
        {filtered.pinned.map((row) => renderRow(row, "pinned"))}
        {boundary("pinned-divider", "Active", "active")}
        {filtered.active.map((row) => renderRow(row, "active"))}
      </ul>
      {!anyMatch && (
        <p className="p-3 text-xs text-muted">
          {sessions.length ? "No matching sessions." : "No sessions yet"}
        </p>
      )}
      <div className="mt-auto pt-3">
        {(["snoozed", "settled"] as const).map((shelf) => {
          const group = filtered[shelf];
          // An empty Settled shelf still appears while dragging, because it is a place to drop.
          if (!group.length && !(shelf === "settled" && dragging)) return null;
          const label = shelf === "snoozed" ? "Snoozed" : "Settled";
          const target = shelf === "settled" && dropShelf === "settled";
          return (
            <section key={shelf} aria-label={label}>
              <Shell id={markerId(`${shelf}-header`)} marker as="div">
                <button
                  type="button"
                  className={`session-section-label ${target ? "text-accent-ink!" : ""}`}
                  aria-expanded={expanded[shelf]}
                  onClick={() => toggle(shelf)}
                >
                  <span className="shrink-0">
                    {label} ({group.length})
                  </span>
                  <span
                    aria-hidden
                    className={`session-section-rule ${target ? "bg-accent/60!" : ""}`}
                  />
                  <ChevronDown
                    aria-hidden
                    className={`size-3 shrink-0 transition-transform ${expanded[shelf] ? "" : "rotate-180"}`}
                  />
                </button>
              </Shell>
              {expanded[shelf] && group.length > 0 && (
                <ul aria-label={`${label} sessions`}>
                  {(shelf === "settled" ? group.slice(0, settledCount) : group).map((row) =>
                    renderRow(row, shelf),
                  )}
                </ul>
              )}
              {shelf === "settled" && expanded.settled && group.length > settledCount && (
                <button
                  type="button"
                  className="px-2 py-2 text-xs text-sidebar-label hover:text-ink"
                  onClick={() => setSettledCount((count) => count + SETTLED_PAGE)}
                >
                  Show 25 more
                </button>
              )}
            </section>
          );
        })}
      </div>
      {notice && (
        <p
          role={notice.alert ? "alert" : "status"}
          className={`p-3 text-xs ${notice.alert ? "text-danger" : "text-muted"}`}
        >
          {notice.text}
        </p>
      )}
      {menu && menuRow && (
        <SessionContextMenu
          label={`Actions for ${menuRow.name}`}
          at={menu.at}
          items={sessionMenuItems({
            session: menuRow,
            now: new Date(),
            can: {
              navigate: live,
              rename: canRename,
              putAway: onClose !== undefined,
              remove: onDelete !== undefined,
              regenerateTitle: onRegenerateTitle !== undefined,
            },
            filteringBySource: repository !== "",
            movable: (() => {
              const { group, index } = neighbours(menuRow);
              return { up: index > 0, down: index >= 0 && index < group.length - 1 };
            })(),
          })}
          onClose={closeMenu}
          onSelect={(id) => {
            if (id === "snooze" || id === "copy") return;
            // Rename takes focus into its field; everything else gives it back to the row.
            closeMenu(id !== "rename");
            chooseFromMenu(id, menuRow);
          }}
        />
      )}
      {dialog && (
        <SessionDialog
          request={dialog}
          onClose={() => setDialog(undefined)}
          onSnooze={(ids, until) => actions.snooze(ids, until)}
          onDelete={(ids) => {
            actions.remove(ids);
            setSelection(NO_SELECTION);
          }}
        />
      )}
    </div>
  );

  if (!drag || !live) return list;
  const { DragLayer } = drag;
  return (
    <DragLayer
      ids={itemIds}
      container={root}
      fixed={SHELF_HEADERS}
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
    >
      {list}
    </DragLayer>
  );
}

/** What a multi-selection can do, in a bar over the list while there is one. */
function BulkBar({
  count,
  canSettle,
  canPark,
  canDelete,
  onSettle,
  onArchive,
  onDelete,
  onClear,
}: {
  count: number;
  canSettle: boolean;
  canPark: boolean;
  canDelete: boolean;
  onSettle: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  const button =
    "rounded-md px-2 py-1 text-ink-2 hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-accent";
  return (
    <div
      role="toolbar"
      aria-label="Selected sessions"
      className="sticky top-0 z-10 mb-1 flex items-center gap-0.5 rounded-md border border-edge bg-field px-2 py-1 text-xs shadow-card"
    >
      <span className="flex-1 text-ink-2" aria-live="polite">
        {count} selected
      </span>
      {canSettle && (
        <button type="button" className={button} onClick={onSettle}>
          Settle
        </button>
      )}
      {canPark && (
        <button type="button" className={button} onClick={onArchive}>
          Archive
        </button>
      )}
      {canDelete && (
        <button
          type="button"
          className={`${button} text-danger hover:text-danger`}
          onClick={onDelete}
        >
          Delete
        </button>
      )}
      <button type="button" aria-label="Clear selection" className={button} onClick={onClear}>
        <X aria-hidden className="size-3.5" />
      </button>
    </div>
  );
}
