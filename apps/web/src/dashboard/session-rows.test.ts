import { NavigationSchema, type SessionSummary } from "@nap/shared/session-navigation";
import { describe, expect, it } from "vitest";
import {
  compactTime,
  isUnread,
  recedes,
  rowStatus,
  SETTLED_PAGE,
  SETTLED_START,
  sessionSource,
  shelveSessions,
  snoozePresets,
  snoozeWakeLabel,
  workingDuration,
} from "./session-rows.ts";

const NOW = Date.parse("2026-10-23T12:00:00.000Z");
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

let counter = 0;
function session(
  over: Partial<SessionSummary> = {},
  nav: Partial<SessionSummary["navigation"]> = {},
) {
  counter += 1;
  const row: SessionSummary = {
    projectId: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    name: `Session ${counter}`,
    status: "ready",
    sandboxId: null,
    sessionIds: [],
    createdAt: at(600),
    updatedAt: at(600),
    navigation: NavigationSchema.parse(nav),
    revision: 0,
    activity: "ready",
    activityAt: null,
    requestedAt: null,
    repository: null,
    branch: null,
    pullRequest: null,
    pendingFeedback: 0,
    ...over,
  };
  return row;
}

describe("shelveSessions", () => {
  it("puts each session on exactly one shelf, and archived ones on none", () => {
    const pinned = session({}, { pinned: true });
    const active = session();
    const snoozed = session({}, { snoozedUntil: at(-60) });
    const settled = session({}, { doneAt: at(5) });
    const archived = session({}, { archivedAt: at(5) });

    const shelves = shelveSessions([pinned, active, snoozed, settled, archived], NOW);

    expect(shelves.pinned).toEqual([pinned]);
    expect(shelves.active).toEqual([active]);
    expect(shelves.snoozed).toEqual([snoozed]);
    expect(shelves.settled).toEqual([settled]);
  });

  it("keeps a running session in the inbox even when it was settled before it ran", () => {
    // Settling is about the work so far; a new request reopens it, as T3's settle does.
    const reopened = session({ activity: "working", requestedAt: at(1) }, { doneAt: at(30) });

    expect(shelveSessions([reopened], NOW).active).toEqual([reopened]);
  });

  it("orders the inbox by the newest request, after any hand-placed rows", () => {
    const old = session({ requestedAt: at(90) });
    const recent = session({ requestedAt: at(2) });
    const neverRun = session({ createdAt: at(30) });
    const placed = session({ requestedAt: at(500) }, { position: 0 });

    expect(shelveSessions([old, recent, neverRun, placed], NOW).active).toEqual([
      placed,
      recent,
      neverRun,
      old,
    ]);
  });

  it("wakes the soonest snooze first and shows the latest settled first", () => {
    const later = session({}, { snoozedUntil: at(-120) });
    const sooner = session({}, { snoozedUntil: at(-10) });
    const settledLong = session({}, { doneAt: at(300) });
    const settledJust = session({}, { doneAt: at(1) });

    const shelves = shelveSessions([later, sooner, settledLong, settledJust], NOW);

    expect(shelves.snoozed).toEqual([sooner, later]);
    expect(shelves.settled).toEqual([settledJust, settledLong]);
  });

  it("pages the settled shelf the way T3 does", () => {
    expect([SETTLED_START, SETTLED_PAGE]).toEqual([10, 25]);
  });
});

describe("rowStatus", () => {
  it("is working, with a start time, while a turn is queued or running", () => {
    expect(rowStatus(session({ activity: "queued", requestedAt: at(3) }))).toEqual({
      kind: "working",
      since: at(3),
    });
    expect(rowStatus(session({ activity: "working", requestedAt: at(1) }))?.kind).toBe("working");
  });

  it("is failed when the session needs attention", () => {
    expect(rowStatus(session({ activity: "attention" }))?.kind).toBe("failed");
  });

  it("is done only while a finished turn has not been looked at", () => {
    const unseen = session({ activity: "completed", activityAt: at(5) }, { readAt: at(10) });
    const seen = session({ activity: "completed", activityAt: at(5) }, { readAt: at(1) });

    expect(rowStatus(unseen)?.kind).toBe("done");
    expect(rowStatus(seen)).toBeNull();
  });

  it("is done when somebody marked the session unread", () => {
    expect(rowStatus(session({}, { unread: true }))?.kind).toBe("done");
  });

  it("is nothing for an idle session somebody has read", () => {
    expect(rowStatus(session())).toBeNull();
  });
});

describe("isUnread", () => {
  it("compares the newest activity with the read watermark", () => {
    expect(isUnread(session({ activityAt: at(5) }))).toBe(true);
    expect(isUnread(session({ activityAt: at(5) }, { readAt: at(1) }))).toBe(false);
    expect(isUnread(session({}, { unread: true }))).toBe(true);
    expect(isUnread(session())).toBe(false);
  });
});

describe("recedes", () => {
  it("dims what needs nothing from the reader, and never the open session", () => {
    expect(recedes(null, false)).toBe(true);
    expect(recedes({ kind: "working", since: at(1) }, false)).toBe(true);
    expect(recedes({ kind: "done" }, false)).toBe(false);
    expect(recedes({ kind: "failed" }, false)).toBe(false);
    expect(recedes(null, true)).toBe(false);
  });
});

describe("sessionSource", () => {
  it("is the repository's short name and its owner", () => {
    expect(sessionSource("northstar-labs/atlas-web")).toEqual({
      key: "northstar-labs/atlas-web",
      label: "atlas-web",
      owner: "northstar-labs",
    });
  });

  it("is Scratch for a session no repository was imported into", () => {
    expect(sessionSource(null)).toEqual({ key: "scratch", label: "Scratch", owner: null });
  });
});

describe("compactTime", () => {
  it("drops the suffix the way T3's sidebar does", () => {
    expect(compactTime(at(0), NOW)).toBe("now");
    expect(compactTime(at(5), NOW)).toBe("5m");
    expect(compactTime(at(180), NOW)).toBe("3h");
    expect(compactTime(at(60 * 24 * 2), NOW)).toBe("2d");
  });
});

describe("workingDuration", () => {
  it("counts seconds, then minutes, then hours and minutes", () => {
    expect(workingDuration(42_000)).toBe("42s");
    expect(workingDuration(5 * 60_000 + 3_000)).toBe("5m");
    expect(workingDuration(83 * 60_000)).toBe("1h 23m");
    expect(workingDuration(-5)).toBe("0s");
  });
});

describe("snoozePresets", () => {
  // Local time throughout: the presets are calendar times where the reader is.
  const local = (day: number, hour: number, minute = 0) =>
    new Date(2026, 9, day, hour, minute, 0, 0);

  it("offers T3's five on a weekday afternoon", () => {
    // Friday 23 October 2026, 14:00.
    const presets = snoozePresets(local(23, 14));

    expect(presets.map((preset) => preset.id)).toEqual([
      "hour",
      "three-hours",
      "evening",
      "tomorrow",
      "next-week",
    ]);
    expect(presets.find((preset) => preset.id === "evening")?.snoozedUntil).toBe(
      local(23, 18).toISOString(),
    );
    expect(presets.find((preset) => preset.id === "tomorrow")?.snoozedUntil).toBe(
      local(24, 9).toISOString(),
    );
    expect(presets.find((preset) => preset.id === "next-week")?.snoozedUntil).toBe(
      local(26, 9).toISOString(),
    );
  });

  it("drops this evening once it is less than an hour away", () => {
    expect(snoozePresets(local(23, 17, 30)).map((preset) => preset.id)).not.toContain("evening");
  });

  it("drops next week when it is tomorrow morning anyway", () => {
    // Sunday: next Monday at nine is the same moment as tomorrow at nine.
    expect(snoozePresets(local(25, 14)).map((preset) => preset.id)).not.toContain("next-week");
  });
});

describe("snoozeWakeLabel", () => {
  it("says how long until it wakes, rounded up", () => {
    expect(snoozeWakeLabel(at(-0.5), NOW)).toBe("1m");
    expect(snoozeWakeLabel(at(-90), NOW)).toBe("2h");
    expect(snoozeWakeLabel(at(-60 * 30), NOW)).toBe("2d");
    expect(snoozeWakeLabel(at(5), NOW)).toBe("now");
  });
});
