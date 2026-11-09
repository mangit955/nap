/**
 * What a session's context menu offers, decided without drawing it.
 *
 * The grouping is T3's: the shelf toggles first, then naming and reading, then copying, then the
 * ones that take the session away. An item is left out — never shown disabled — when it could
 * not work: work in progress cannot be parked, a session with no branch has none to copy, and a
 * page that was given no way to rename offers no Rename.
 *
 * Adapted from T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.), `threadActionMenu.logic.ts`.
 */

import { type SessionSummary, sessionSection } from "@nap/shared/session-navigation";
import { isUnread, type SnoozePreset, sessionSource, snoozePresets } from "./session-rows.ts";

export type MenuItemId =
  | "pin"
  | "unpin"
  | "settle"
  | "unsettle"
  | "snooze"
  | `snooze:${SnoozePreset["id"]}`
  | "snooze:custom"
  | "wake"
  | "move-up"
  | "move-down"
  | "rename"
  | "regenerate-title"
  | "mark-unread"
  | "mark-read"
  | "filter-source"
  | "show-all-sources"
  | "copy"
  | "copy-link"
  | "copy-branch"
  | "put-away"
  | "archive"
  | "delete";

export type MenuItem = {
  id: MenuItemId;
  label: string;
  /** Drawn on the right, and part of the accessible name — a snooze preset's wake time. */
  detail?: string;
  destructive?: boolean;
  separatorBefore?: boolean;
  children?: MenuItem[];
};

export type SessionMenuState = {
  session: SessionSummary;
  now: Date;
  /** What the page hosting the sidebar was given a way to do. */
  can: {
    navigate: boolean;
    rename: boolean;
    putAway: boolean;
    remove: boolean;
    /** A model may be asked for a title (docs/adr/0031); absent on pages that cannot ask. */
    regenerateTitle?: boolean;
  };
  filteringBySource: boolean;
  /**
   * Whether the row has a neighbour on its shelf to swap with. Dragging reorders a shelf, and
   * these are how a keyboard does the same thing.
   */
  movable?: { up: boolean; down: boolean } | undefined;
};

export function sessionMenuItems({
  session,
  now,
  can,
  filteringBySource,
  movable,
}: SessionMenuState): MenuItem[] {
  const section = sessionSection(session, now.getTime());
  const working = session.activity === "working" || session.activity === "queued";
  const items: MenuItem[] = [];
  if (can.navigate) {
    items.push(
      session.navigation.pinned ? { id: "unpin", label: "Unpin" } : { id: "pin", label: "Pin" },
    );
    if (section === "done") items.push({ id: "unsettle", label: "Un-settle" });
    else if (!working) items.push({ id: "settle", label: "Settle" });
    if (section === "snoozed") items.push({ id: "wake", label: "Wake" });
    else if (!working)
      items.push({
        id: "snooze",
        label: "Snooze",
        children: [
          ...snoozePresets(now).map((preset) => ({
            id: `snooze:${preset.id}` as const,
            label: preset.label,
            detail: preset.whenLabel,
          })),
          { id: "snooze:custom", label: "Custom…", separatorBefore: true },
        ],
      });
    if (movable?.up) items.push({ id: "move-up", label: "Move up" });
    if (movable?.down) items.push({ id: "move-down", label: "Move down" });
  }
  if (can.rename) items.push({ id: "rename", label: "Rename", separatorBefore: true });
  // Left out while one is already being written, rather than offered and refused.
  if (can.regenerateTitle && !session.titling)
    items.push({
      id: "regenerate-title",
      label: "Regenerate title",
      separatorBefore: !can.rename,
    });
  if (can.navigate)
    items.push(
      isUnread(session)
        ? { id: "mark-read", label: "Mark read" }
        : { id: "mark-unread", label: "Mark unread" },
    );
  items.push(
    filteringBySource
      ? { id: "show-all-sources", label: "Show all sources" }
      : { id: "filter-source", label: `Filter by ${sessionSource(session.repository).label}` },
  );
  items.push({
    id: "copy",
    label: "Copy",
    separatorBefore: true,
    children: [
      { id: "copy-link", label: "Session link" },
      ...(session.branch ? [{ id: "copy-branch" as const, label: "Branch" }] : []),
    ],
  });
  const leaving: MenuItem[] = [];
  if (can.putAway && session.sandboxId !== null && !working)
    leaving.push({ id: "put-away", label: "Put away workspace" });
  if (can.navigate && !working) leaving.push({ id: "archive", label: "Archive" });
  if (can.remove && !working) leaving.push({ id: "delete", label: "Delete", destructive: true });
  const [first, ...rest] = leaving;
  if (first) items.push({ ...first, separatorBefore: true }, ...rest);
  // A group that opens the menu has nothing above it to be separated from.
  const [head, ...tail] = items;
  return head ? [{ ...head, separatorBefore: false }, ...tail] : [];
}
