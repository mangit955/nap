"use client";

import {
  type NavigationChange,
  type SessionReorder,
  type SessionSummary,
  sessionSection,
} from "@nap/shared/session-navigation";
import { useEffect, useRef, useState } from "react";
import { SessionActions } from "./session-actions.tsx";
import { SessionRow } from "./session-row.tsx";
import {
  isUnread,
  SETTLED_PAGE,
  SETTLED_START,
  type Shelf,
  sessionSource,
  shelveSessions,
} from "./session-rows.ts";

export function SessionList({
  draftIds,
  sessions,
  activeProjectId,
  query,
  repository,
  ownerId,
  busyProjectId,
  onChange,
  onReorder,
  onRename,
  onDelete,
  onClose,
  onLayout,
}: {
  onLayout?: ((selected: HTMLAnchorElement | null) => void) | undefined;
  draftIds?: ReadonlySet<string> | undefined;
  sessions: readonly SessionSummary[];
  activeProjectId?: string | undefined;
  query: string;
  repository: string;
  ownerId?: string | undefined;
  busyProjectId?: string | undefined;
  onChange?: ((id: string, change: NavigationChange["change"]) => void) | undefined;
  onReorder?: ((input: SessionReorder) => void) | undefined;
  onRename?: ((id: string, name: string) => void) | undefined;
  onDelete?: ((id: string) => void) | undefined;
  onClose?: ((id: string) => void) | undefined;
}) {
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
  const [dragged, setDragged] = useState<string>();
  const [drop, setDrop] = useState<string>();
  const [copyError, setCopyError] = useState<string>();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const shelves = shelveSessions(sessions, now);
  const sorted = [...shelves.pinned, ...shelves.active, ...shelves.snoozed, ...shelves.settled];
  const matches = (row: SessionSummary) =>
    (!repository || sessionSource(row.repository).key === repository) &&
    row.name.toLowerCase().includes(query.trim().toLowerCase());
  const filtered = shelveSessions(sorted.filter(matches), now);
  const drawn = [
    ...filtered.pinned,
    ...filtered.active,
    ...(expanded.snoozed ? filtered.snoozed : []),
    ...(expanded.settled ? filtered.settled.slice(0, settledCount) : []),
  ];
  const selectedOutside = sorted.find(
    (row) => row.projectId === activeProjectId && !drawn.includes(row),
  );
  const selected = drawn.find((row) => row.projectId === activeProjectId);
  const selectedPlacement = selectedOutside ? "current" : selected && sessionSection(selected, now);
  // biome-ignore lint/correctness/useExhaustiveDependencies: reveal when selection changes placement, never on a polling-only render.
  useEffect(() => {
    if (restoredKey === storageKey) {
      onLayout?.(root.current?.querySelector<HTMLAnchorElement>('a[aria-current="page"]') ?? null);
    }
  }, [onLayout, restoredKey, storageKey, activeProjectId, selectedPlacement]);
  const move = (id: string, target: string, before = false) => {
    const row = sorted.find((item) => item.projectId === id);
    if (!row) return;
    const section = sessionSection(row, now);
    const group = sorted.filter((item) => sessionSection(item, now) === section);
    const from = group.findIndex((item) => item.projectId === id);
    const to = group.findIndex((item) => item.projectId === target);
    if (from < 0 || to < 0 || from === to) return;
    group.splice(from, 1);
    group.splice(before && from < to ? to - 1 : to, 0, row);
    onReorder?.({
      section,
      rows: group.map((item) => ({ projectId: item.projectId, revision: item.revision })),
    });
  };
  const copy = async (value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopyError(undefined);
    } catch {
      setCopyError("Could not copy. Check clipboard access and try again.");
    }
  };
  const renderRow = (row: SessionSummary, shelf: Shelf) => {
    const section = sessionSection(row, now);
    const group = sorted.filter((item) => sessionSection(item, now) === section);
    const index = group.indexOf(row);
    const previous = group[index - 1];
    const next = group[index + 1];
    const active = row.activity === "working" || row.activity === "queued";
    const unread = isUnread(row);
    const actions: { label: string; disabled?: boolean; onSelect: () => void }[] = [
      {
        label: row.navigation.pinned ? "Unpin" : "Pin",
        onSelect: () => onChange?.(row.projectId, { kind: "pin", pinned: !row.navigation.pinned }),
      },
      {
        label: section === "done" ? "Un-settle" : "Settle",
        disabled: active,
        onSelect: () => onChange?.(row.projectId, { kind: "done", value: section !== "done" }),
      },
      {
        label: unread ? "Mark read" : "Mark unread",
        onSelect: () =>
          onChange?.(row.projectId, { kind: "read", at: row.activityAt, unread: !unread }),
      },
      {
        label: "Copy session link",
        onSelect: () => void copy(`${window.location.origin}/p/${row.projectId}`),
      },
      ...(row.branch
        ? [{ label: "Copy branch", onSelect: () => void copy(row.branch ?? "") }]
        : []),
      {
        label: "Move up",
        disabled: !previous,
        onSelect: () => {
          if (previous) move(row.projectId, previous.projectId);
        },
      },
      {
        label: "Move down",
        disabled: !next,
        onSelect: () => {
          if (next) move(row.projectId, next.projectId);
        },
      },
      ...(section === "snoozed"
        ? [
            {
              label: "Wake",
              onSelect: () => onChange?.(row.projectId, { kind: "snooze", until: null }),
            },
          ]
        : []),
      {
        label: section === "archived" ? "Restore" : "Archive",
        disabled: active,
        onSelect: () =>
          onChange?.(row.projectId, { kind: "archive", value: section !== "archived" }),
      },
    ];
    return (
      <SessionRow
        key={row.projectId}
        session={row}
        shelf={shelf}
        isOpen={row.projectId === activeProjectId}
        hasDraft={draftIds?.has(row.projectId) ?? false}
        now={now}
        busy={busyProjectId === row.projectId}
        onOpen={() => {
          if (unread)
            onChange?.(row.projectId, { kind: "read", at: row.activityAt, unread: false });
        }}
        onSettle={
          onChange && !active
            ? (value) => onChange(row.projectId, { kind: "done", value })
            : undefined
        }
        onSnooze={
          onChange && !active
            ? (until) => onChange(row.projectId, { kind: "snooze", until })
            : undefined
        }
        onRename={onRename ? (name) => onRename(row.projectId, name) : undefined}
        rowProps={{
          "data-drop": drop === row.projectId,
          draggable: !!onReorder && !busyProjectId,
          onDragStart: (event) => {
            setDragged(row.projectId);
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", row.projectId);
          },
          onDragEnd: () => {
            setDragged(undefined);
            setDrop(undefined);
          },
          onDragOver: (event) => {
            if (
              dragged &&
              sorted.some(
                (item) => item.projectId === dragged && sessionSection(item, now) === section,
              )
            ) {
              event.preventDefault();
              setDrop(row.projectId);
            }
          },
          onDrop: (event) => {
            event.preventDefault();
            if (dragged) move(dragged, row.projectId, true);
            setDragged(undefined);
            setDrop(undefined);
          },
          onContextMenu: (event) => {
            event.preventDefault();
            event.currentTarget.querySelector<HTMLButtonElement>(".session-actions")?.click();
          },
        }}
        actions={
          <SessionActions
            name={row.name}
            disabled={busyProjectId === row.projectId}
            extraActions={onChange ? actions : []}
            onSnooze={
              onChange && !active && section !== "archived"
                ? (until) => onChange(row.projectId, { kind: "snooze", until })
                : undefined
            }
            onRename={onRename ? (name) => onRename(row.projectId, name) : undefined}
            onClose={onClose && row.sandboxId && !active ? () => onClose(row.projectId) : undefined}
            onDelete={onDelete && !active ? () => onDelete(row.projectId) : undefined}
          />
        }
      />
    );
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: delegates arrow keys from the session links only.
    <div
      ref={root}
      className="flex min-h-full flex-col"
      onKeyDown={(event) => {
        if (
          !(event.target instanceof HTMLAnchorElement) ||
          !event.target.hasAttribute("data-session-link") ||
          !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
        )
          return;
        const links = [
          ...event.currentTarget.querySelectorAll<HTMLAnchorElement>("a[data-session-link]"),
        ];
        const index = links.indexOf(event.target);
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
      {selectedOutside && (
        <ul aria-label="Current session">{renderRow(selectedOutside, "active")}</ul>
      )}
      <ul aria-label="Inbox sessions">
        {filtered.pinned.map((row) => renderRow(row, "pinned"))}
        {filtered.active.map((row) => renderRow(row, "active"))}
      </ul>
      {!sorted.some(matches) && (
        <p className="p-3 text-xs text-muted">
          {sessions.length ? "No matching sessions." : "No sessions yet"}
        </p>
      )}
      <div className="mt-auto pt-3">
        {(["snoozed", "settled"] as const).map((shelf) => {
          const group = filtered[shelf];
          if (!group.length) return null;
          const label = shelf === "snoozed" ? "Snoozed" : "Settled";
          return (
            <section key={shelf} aria-label={label}>
              <button
                type="button"
                className="session-section-label"
                aria-expanded={expanded[shelf]}
                onClick={() => toggle(shelf)}
              >
                <span aria-hidden>{expanded[shelf] ? "⌄" : "›"}</span> {label} ({group.length})
              </button>
              {expanded[shelf] && (
                <ul aria-label={`${label} sessions`}>
                  {(shelf === "settled" ? group.slice(0, settledCount) : group).map((row) =>
                    renderRow(row, shelf),
                  )}
                </ul>
              )}
              {shelf === "settled" && expanded.settled && group.length > settledCount && (
                <button
                  type="button"
                  className="px-2.5 py-2 text-xs text-muted hover:text-ink"
                  onClick={() => setSettledCount((count) => count + SETTLED_PAGE)}
                >
                  Show 25 more
                </button>
              )}
            </section>
          );
        })}
      </div>
      {copyError && (
        <p role="alert" className="p-3 text-xs text-danger">
          {copyError}
        </p>
      )}
    </div>
  );
}
