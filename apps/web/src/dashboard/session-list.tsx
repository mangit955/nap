"use client";

import {
  type NavigationChange,
  type SessionReorder,
  type SessionSection,
  type SessionSummary,
  sessionSection,
} from "@nap/shared/session-navigation";
import { useEffect, useRef, useState } from "react";
import type { ProjectScope } from "./filters.ts";
import { SessionActions } from "./session-actions.tsx";

const SECTION_NAMES = {
  pinned: "Pinned",
  active: "Active",
  snoozed: "Snoozed",
  done: "Done",
  archived: "Archived",
};
const STATUS = {
  ready: "Ready",
  queued: "Queued",
  working: "Working",
  completed: "Completed",
  attention: "Needs attention",
};

export function SessionList({
  draftIds,
  sessions,
  activeProjectId,
  scope,
  query,
  repository,
  showArchived,
  busyProjectId,
  onChange,
  onReorder,
  onRename,
  onDelete,
  onClose,
}: {
  draftIds?: ReadonlySet<string> | undefined;
  sessions: readonly SessionSummary[];
  activeProjectId?: string | undefined;
  scope: ProjectScope;
  query: string;
  repository: string;
  showArchived: boolean;
  busyProjectId?: string | undefined;
  onChange?: ((id: string, change: NavigationChange["change"]) => void) | undefined;
  onReorder?: ((input: SessionReorder) => void) | undefined;
  onRename?: ((id: string, name: string) => void) | undefined;
  onDelete?: ((id: string) => void) | undefined;
  onClose?: ((id: string) => void) | undefined;
}) {
  const [now, setNow] = useState(Date.now);
  const [collapsed, setCollapsed] = useState<Set<SessionSection>>(new Set(["snoozed", "done"]));
  const [dragged, setDragged] = useState<string>();
  const [drop, setDrop] = useState<string>();
  const [copyError, setCopyError] = useState<string>();
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  const sorted = [...sessions].sort(
    (a, b) =>
      (a.navigation.position ?? Number.MAX_SAFE_INTEGER) -
        (b.navigation.position ?? Number.MAX_SAFE_INTEGER) ||
      Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
      a.projectId.localeCompare(b.projectId),
  );
  const visible = sorted.filter(
    (row) =>
      (showArchived
        ? sessionSection(row, now) === "archived"
        : sessionSection(row, now) !== "archived") &&
      (!repository || row.repository === repository) &&
      (scope !== "running" || row.sandboxId !== null) &&
      (scope !== "put-away" || row.sandboxId === null) &&
      row.name.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const selectedOutside = sorted.find(
    (row) => row.projectId === activeProjectId && !visible.includes(row),
  );
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
  const renderRow = (row: SessionSummary, compact = false) => {
    const section = sessionSection(row, now);
    const group = sorted.filter((item) => sessionSection(item, now) === section);
    const index = group.indexOf(row);
    const previous = group[index - 1];
    const next = group[index + 1];
    const active = row.activity === "working" || row.activity === "queued";
    const unread =
      row.navigation.unread ||
      (row.activityAt !== null &&
        (!row.navigation.readAt || Date.parse(row.activityAt) > Date.parse(row.navigation.readAt)));
    const actions: { label: string; disabled?: boolean; onSelect: () => void }[] = [
      {
        label: row.navigation.pinned ? "Unpin" : "Pin",
        onSelect: () => onChange?.(row.projectId, { kind: "pin", pinned: !row.navigation.pinned }),
      },
      {
        label: section === "done" ? "Reopen" : "Mark done",
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
      <li
        key={row.projectId}
        className="session-row group"
        data-selected={row.projectId === activeProjectId}
        data-compact={compact}
        data-drop={drop === row.projectId}
        draggable={!!onReorder && !busyProjectId}
        onDragStart={(event) => {
          setDragged(row.projectId);
          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", row.projectId);
        }}
        onDragEnd={() => {
          setDragged(undefined);
          setDrop(undefined);
        }}
        onDragOver={(event) => {
          if (
            dragged &&
            sorted.some(
              (item) => item.projectId === dragged && sessionSection(item, now) === section,
            )
          ) {
            event.preventDefault();
            setDrop(row.projectId);
          }
        }}
        onDrop={(event) => {
          event.preventDefault();
          if (dragged) move(dragged, row.projectId, true);
          setDragged(undefined);
          setDrop(undefined);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.currentTarget.querySelector<HTMLButtonElement>(".session-actions")?.click();
        }}
      >
        <a
          href={`/p/${row.projectId}`}
          aria-current={row.projectId === activeProjectId ? "page" : undefined}
          className="session-card"
          onKeyDown={(event) => {
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            const links = [
              ...(root.current?.querySelectorAll<HTMLAnchorElement>("a.session-card") ?? []),
            ];
            const current = links.indexOf(event.currentTarget);
            const next =
              event.key === "Home"
                ? 0
                : event.key === "End"
                  ? links.length - 1
                  : current + (event.key === "ArrowDown" ? 1 : -1);
            event.preventDefault();
            links[Math.max(0, Math.min(links.length - 1, next))]?.focus();
          }}
          onClick={() => {
            if (unread)
              onChange?.(row.projectId, { kind: "read", at: row.activityAt, unread: false });
          }}
        >
          <span className="session-card-meta">
            <span className="session-repository" title={row.repository ?? row.name}>
              {row.repository ?? "Nap project"}
            </span>
            <span className="session-status" data-status={row.activity}>
              {STATUS[row.activity]}
            </span>
          </span>
          <span className="session-title">
            {row.name}
            {draftIds?.has(row.projectId) && <small className="ml-2 text-muted">Draft</small>}
            {unread && (
              <span className="session-unread" title="Unread">
                <span className="sr-only">Unread</span>
              </span>
            )}
          </span>
          {!compact && (
            <span className="session-card-detail">
              <span title={row.branch ?? undefined}>
                {row.branch ??
                  (row.sandboxId
                    ? "Workspace running"
                    : row.status === "creating"
                      ? "Workspace pending"
                      : "Workspace put away")}
              </span>
              {row.pullRequest && (
                <span title={`${row.pullRequest.state} pull request`}>
                  #{row.pullRequest.number} · {row.pullRequest.state}
                </span>
              )}
              {row.pendingFeedback > 0 && <span>{row.pendingFeedback} feedback</span>}
            </span>
          )}
        </a>
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
      </li>
    );
  };
  const sections: SessionSection[] = showArchived
    ? ["archived"]
    : ["pinned", "active", "snoozed", "done"];
  return (
    <div ref={root}>
      {selectedOutside && (
        <>
          <p className="session-section-label">Current session · outside filters</p>
          <ul aria-label="Current session">{renderRow(selectedOutside)}</ul>
        </>
      )}
      {sections.map((section) => {
        const group = visible.filter((row) => sessionSection(row, now) === section);
        const folded =
          collapsed.has(section) && !group.some((row) => row.projectId === activeProjectId);
        if (!group.length && section !== "active") return null;
        return (
          <section key={section} aria-label={SECTION_NAMES[section]}>
            <button
              type="button"
              className="session-section-label"
              aria-expanded={!folded}
              onClick={() =>
                setCollapsed((current) => {
                  const next = new Set(current);
                  if (next.has(section)) next.delete(section);
                  else next.add(section);
                  return next;
                })
              }
            >
              {folded ? "›" : "⌄"} {SECTION_NAMES[section]}
              <span>{group.length}</span>
            </button>
            {!folded && (
              <ul aria-label={`${SECTION_NAMES[section]} sessions`}>
                {group.map((row) =>
                  renderRow(
                    row,
                    section === "done" || section === "snoozed" || section === "archived",
                  ),
                )}
              </ul>
            )}
          </section>
        );
      })}
      {!visible.length && (
        <p className="p-3 text-xs text-muted">
          {sessions.length ? "No matching sessions." : "No sessions yet"}
        </p>
      )}
      {copyError && (
        <p role="alert" className="p-3 text-xs text-danger">
          {copyError}
        </p>
      )}
    </div>
  );
}
