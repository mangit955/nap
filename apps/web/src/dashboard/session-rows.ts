/**
 * What the session sidebar draws, decided without drawing it.
 *
 * The sidebar is T3 Code's: one inbox rather than a set of headed sections. Pinned rows sit at
 * the top, the active inbox under them, and Snoozed and Settled are shelves at the bottom. A
 * row's status slot speaks only when there is something to do about it, and a session that
 * needs nothing from the reader *recedes* instead of wearing an unread dot. Every one of those
 * rules lives here, as plain functions, because a rule that only exists inside a component is
 * checkable only by mounting it.
 *
 * Adapted from T3 Code (MIT, Copyright (c) 2026 T3 Tools Inc.): `Sidebar.tsx`'s partition,
 * `Sidebar.logic.ts`'s status and recede rules, and `threadSort.ts`'s shelf orders.
 */

import { type SessionSummary, sessionSection } from "@nap/shared/session-navigation";
import { relativeTime } from "./relative-time.ts";

/** Where a row sits. *Settled* is the API's `done`; an archived session is on no shelf. */
export type Shelf = "pinned" | "active" | "snoozed" | "settled";

export type Shelves = {
  pinned: SessionSummary[];
  active: SessionSummary[];
  snoozed: SessionSummary[];
  settled: SessionSummary[];
};

/** How many settled rows show when the shelf opens, and how many each "Show more" adds. */
export const SETTLED_START = 10;
export const SETTLED_PAGE = 25;

/**
 * Every visible session on exactly one shelf.
 *
 * The shelf itself is `sessionSection`'s answer, so the server's reorder check and this list
 * cannot disagree about where a row is: *done* is drawn as Settled, and an archived session is
 * on no shelf at all — it lives on Settings → Archived, as T3's archive does.
 */
export function shelveSessions(sessions: readonly SessionSummary[], now: number): Shelves {
  const shelves: Shelves = { pinned: [], active: [], snoozed: [], settled: [] };
  for (const session of sessions) {
    const section = sessionSection(session, now);
    if (section === "archived") continue;
    shelves[section === "done" ? "settled" : section].push(session);
  }
  shelves.pinned.sort(byPlacementThenRecency);
  shelves.active.sort(byPlacementThenRecency);
  // The next one to wake first, so the shelf reads as a queue.
  shelves.snoozed.sort(
    (left, right) => time(left.navigation.snoozedUntil) - time(right.navigation.snoozedUntil),
  );
  // The latest settled first: the one somebody is most likely to want back.
  shelves.settled.sort(
    (left, right) =>
      time(right.navigation.doneAt) - time(left.navigation.doneAt) ||
      left.projectId.localeCompare(right.projectId),
  );
  return shelves;
}

/**
 * A row somebody dragged into place keeps its place; the rest follow the newest request, which
 * is T3's inbox order. A session that has never run sorts by when it was made, so a new one
 * arrives at the top rather than below everything that ever ran.
 */
function byPlacementThenRecency(left: SessionSummary, right: SessionSummary): number {
  return (
    (left.navigation.position ?? Number.MAX_SAFE_INTEGER) -
      (right.navigation.position ?? Number.MAX_SAFE_INTEGER) ||
    time(right.requestedAt ?? right.createdAt) - time(left.requestedAt ?? left.createdAt) ||
    left.projectId.localeCompare(right.projectId)
  );
}

function time(iso: string | null): number {
  if (iso === null) return 0;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** What the right end of a row's first line says, when it says anything but a time. */
export type RowStatus =
  | { kind: "working"; since: string | null }
  | { kind: "failed" }
  | { kind: "done" };

/**
 * Whether the reader has seen the newest thing that happened here. An explicit "mark unread"
 * wins over the watermark, exactly as T3's rewound visit time does.
 */
export function isUnread(session: SessionSummary): boolean {
  const { unread, readAt } = session.navigation;
  if (unread) return true;
  if (session.activityAt === null) return false;
  return readAt === null || time(session.activityAt) > time(readAt);
}

/**
 * T3's status slot. Queued counts as working, as T3's `preparing` and `queued` do: from where
 * the reader sits both mean "Nap has this". `Done` is a finished turn nobody has looked at yet;
 * once read, the slot goes back to a plain time, because a row that says Done forever says
 * nothing.
 */
export function rowStatus(session: SessionSummary): RowStatus | null {
  if (session.activity === "working" || session.activity === "queued")
    return { kind: "working", since: session.requestedAt };
  if (session.activity === "attention") return { kind: "failed" };
  return isUnread(session) ? { kind: "done" } : null;
}

/**
 * Whether a row steps back — normal weight, secondary colour. T3's `shouldRecedeSidebarThread`
 * without the states Nap has no word for: anything idle and read recedes, and so does work in
 * progress, which needs watching rather than acting on. The open session never does.
 */
export function recedes(status: RowStatus | null, isOpen: boolean): boolean {
  if (isOpen) return false;
  return status === null || status.kind === "working";
}

export type SessionSource = { key: string; label: string; owner: string | null };

/** The key the source filter uses for every session that came from no repository. */
export const SCRATCH = "scratch";

/**
 * A row's first line: the repository a session was imported from, or Scratch. T3 calls this
 * the thread's project; Nap's glossary already uses *Project* for the row itself, so here it is
 * the session's **source**.
 */
export function sessionSource(repository: string | null): SessionSource {
  if (repository === null) return { key: SCRATCH, label: "Scratch", owner: null };
  const slash = repository.indexOf("/");
  return slash < 0
    ? { key: repository, label: repository, owner: null }
    : { key: repository, label: repository.slice(slash + 1), owner: repository.slice(0, slash) };
}

/** `5m`, `3h`, `now` — T3's sidebar trims the suffix the rest of the app keeps. */
export function compactTime(iso: string, now: number): string {
  const label = relativeTime(iso, now);
  if (label === "just now") return "now";
  return label.endsWith(" ago") ? label.slice(0, -4) : label;
}

/** T3's live timer beside *Working*: seconds, then minutes, then hours and minutes. */
export function workingDuration(elapsedMs: number): string {
  const seconds = Number.isFinite(elapsedMs) ? Math.max(0, Math.floor(elapsedMs / 1000)) : 0;
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export type SnoozePreset = {
  id: "hour" | "three-hours" | "evening" | "tomorrow" | "next-week";
  label: string;
  /** When it wakes, in the reader's own clock — "6:00 PM", or "Mon 9:00 AM" a week out. */
  whenLabel: string;
  snoozedUntil: string;
};

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const EVENING_HOUR = 18;
const MORNING_HOUR = 9;

/**
 * T3's snooze menu. Evening and morning are calendar times where the reader is, and a day is a
 * calendar day rather than 24 hours — across a clock change a fixed offset lands on the wrong
 * morning. "This evening" goes once it is under an hour away, and "Next week" goes on a Sunday,
 * when it would be the same moment as "Tomorrow".
 */
export function snoozePresets(now: Date): SnoozePreset[] {
  const atHour = (base: Date, hour: number) => {
    const next = new Date(base);
    next.setHours(hour, 0, 0, 0);
    return next;
  };
  const addDays = (base: Date, days: number) => {
    const next = new Date(base);
    next.setDate(next.getDate() + days);
    return next;
  };
  const clock = (date: Date) =>
    date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const preset = (id: SnoozePreset["id"], label: string, wake: Date, whenLabel = clock(wake)) => ({
    id,
    label,
    whenLabel,
    snoozedUntil: wake.toISOString(),
  });

  const presets = [
    preset("hour", "In 1 hour", new Date(now.getTime() + HOUR_MS)),
    preset("three-hours", "In 3 hours", new Date(now.getTime() + 3 * HOUR_MS)),
  ];
  const evening = atHour(now, EVENING_HOUR);
  if (evening.getTime() - now.getTime() > HOUR_MS)
    presets.push(preset("evening", "This evening", evening));
  const tomorrow = atHour(addDays(now, 1), MORNING_HOUR);
  presets.push(preset("tomorrow", "Tomorrow", tomorrow));
  const nextWeek = atHour(addDays(now, (1 - now.getDay() + 7) % 7 || 7), MORNING_HOUR);
  if (nextWeek.getTime() !== tomorrow.getTime())
    presets.push(
      preset(
        "next-week",
        "Next week",
        nextWeek,
        `${nextWeek.toLocaleDateString(undefined, { weekday: "short" })} ${clock(nextWeek)}`,
      ),
    );
  return presets;
}

/** How long until a snoozed row wakes, rounded up — `12m`, `3h`, `2d`, or `now` once it has. */
export function snoozeWakeLabel(snoozedUntil: string, now: number): string {
  const remaining = time(snoozedUntil) - now;
  if (remaining <= 0) return "now";
  if (remaining < HOUR_MS) return `${Math.max(1, Math.ceil(remaining / 60_000))}m`;
  if (remaining < DAY_MS) return `${Math.ceil(remaining / HOUR_MS)}h`;
  return `${Math.ceil(remaining / DAY_MS)}d`;
}
