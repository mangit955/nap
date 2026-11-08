/**
 * Where a dragged row lands, and what landing there asks the server to do.
 *
 * The sidebar is one flat list with **markers** in it — the Pinned and Active boundaries and the
 * shelf headers — and a row's shelf is decided by the last marker above it. Dropping is then a
 * question about a list rather than about pixels: move the row to where it was dropped, and read
 * its shelf back off the markers. That keeps every rule here checkable without a layout, which
 * jsdom does not have.
 *
 * Adapted from T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.), `Sidebar.logic.ts`'s
 * `resolveSidebarDropTarget` and `resolveSidebarDropVerb`.
 */

import {
  type NavigationChange,
  type SessionSummary,
  sessionSection,
} from "@nap/shared/session-navigation";
import type { NavigationStep } from "../projects/use-session-navigation.ts";
import { type Shelf, shelveSessions } from "./session-rows.ts";

export type ListMarker = "pinned-header" | "pinned-divider" | "snoozed-header" | "settled-header";
export type ListItem = { kind: "row"; id: string } | { kind: "marker"; marker: ListMarker };

/** A marker's id among the rows' ids. A project id is a UUID, so the two cannot collide. */
export function markerId(marker: ListMarker): string {
  return `marker:${marker}`;
}

export function listItemId(item: ListItem): string {
  return item.kind === "row" ? item.id : markerId(item.marker);
}

/** A shelf a row can be dropped on. Snoozed is not one: snoozing needs a wake time. */
export type DropShelf = "pinned" | "active" | "settled";
export type DropTarget = { shelf: DropShelf; order: string[] };

const OPENS: Record<ListMarker, Shelf> = {
  "pinned-header": "pinned",
  "pinned-divider": "active",
  "snoozed-header": "snoozed",
  "settled-header": "settled",
};

/**
 * The shelf `activeId` lands on when dropped over `overId`, and that shelf's rows in their new
 * order — or null for a drop that means nothing. The move is the sortable list's own: a row
 * dragged down past another lands after it, dragged up lands before it.
 */
export function dropTarget(
  items: readonly ListItem[],
  activeId: string,
  overId: string,
): DropTarget | null {
  const from = items.findIndex((item) => listItemId(item) === activeId);
  const to = items.findIndex((item) => listItemId(item) === overId);
  const dragged = items[from];
  if (from < 0 || to < 0 || dragged?.kind !== "row") return null;
  const moved = items.filter((_, index) => index !== from);
  moved.splice(to, 0, dragged);
  let shelf: Shelf = "pinned";
  const order: string[] = [];
  for (const [index, item] of moved.entries()) {
    if (item.kind === "marker") {
      if (index < to) {
        shelf = OPENS[item.marker];
        order.length = 0;
      } else if (index > to) break;
    } else order.push(item.id);
  }
  return shelf === "snoozed" ? null : { shelf, order };
}

function shelfOf(session: SessionSummary, now: number): Shelf | "archived" {
  const section = sessionSection(session, now);
  return section === "done" ? "settled" : section;
}

/**
 * The changes that move one session onto a shelf, in the order they must be applied, or null
 * when it cannot go there. A settled row is un-settled before it is pinned, because a pinned
 * row that is still settled stays on the Settled shelf. Work in progress cannot be settled: the
 * server refuses to park a session with a turn running.
 */
export function shelfMoveChanges(
  session: SessionSummary,
  to: DropShelf,
  now: number,
): NavigationChange["change"][] | null {
  const from = shelfOf(session, now);
  if (from === to) return [];
  if (to === "settled") {
    const working = session.activity === "working" || session.activity === "queued";
    return working ? null : [{ kind: "done", value: true }];
  }
  const changes: NavigationChange["change"][] = [];
  if (from === "settled") changes.push({ kind: "done", value: false });
  if (from === "snoozed") changes.push({ kind: "snooze", until: null });
  const pinned = to === "pinned";
  if (session.navigation.pinned !== pinned) changes.push({ kind: "pin", pinned });
  return changes;
}

/**
 * The full order of a shelf after a drop, when some of its rows were not drawn — hidden by a
 * search or a source filter. The moved row goes just before the drawn row it was dropped above,
 * or just after the one it was dropped below, so hidden rows keep their places.
 */
export function mergeOrder(
  full: readonly string[],
  drawn: readonly string[],
  moved: string,
): string[] {
  const order = full.filter((id) => id !== moved);
  const at = drawn.indexOf(moved);
  const next = drawn.slice(at + 1).find((id) => order.includes(id));
  if (next !== undefined) {
    order.splice(order.indexOf(next), 0, moved);
    return order;
  }
  const previous = drawn
    .slice(0, Math.max(0, at))
    .reverse()
    .find((id) => order.includes(id));
  order.splice(previous === undefined ? order.length : order.indexOf(previous) + 1, 0, moved);
  return order;
}

/**
 * Everything one drop sends: the changes that move the row, then — for the inbox and Pinned —
 * the shelf's new order, so it stays where it was let go. Settled is ordered by when each row
 * settled, so a drop there sends no order. An empty plan means there is nothing to do.
 */
export function planDrop(
  sessions: readonly SessionSummary[],
  session: SessionSummary,
  target: DropTarget,
  now: number,
): NavigationStep[] {
  const changes = shelfMoveChanges(session, target.shelf, now);
  if (changes === null) return [];
  const steps: NavigationStep[] = changes.map((change) => ({
    kind: "change",
    projectId: session.projectId,
    change,
  }));
  if (target.shelf === "settled") return steps;
  const full = shelveSessions(sessions, now)[target.shelf].map((row) => row.projectId);
  const order = mergeOrder(full, target.order, session.projectId);
  const unchanged =
    changes.length === 0 && order.length === full.length && order.every((id, i) => id === full[i]);
  if (unchanged) return [];
  steps.push({ kind: "reorder", section: target.shelf, projectIds: order });
  return steps;
}
