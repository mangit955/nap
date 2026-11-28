import { NavigationSchema, type SessionSummary } from "@nap/shared/session-navigation";
import { describe, expect, it } from "vitest";
import {
  compactTime,
  diffLabel,
  finishedInBackground,
  isUnread,
  isWoke,
  modelLabel,
  rangeBetween,
  recedes,
  rowStatus,
  SETTLED_PAGE,
  SETTLED_START,
  seenChange,
  sessionSource,
  settledFinishes,
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
    runStartedAt: null,
    turnFinishedAt: null,
    diff: null,
    model: null,
    titling: false,
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
  it("is queued, with no clock, while a turn waits to be claimed", () => {
    expect(rowStatus(session({ activity: "queued", requestedAt: at(3) }), NOW)).toEqual({
      kind: "queued",
    });
  });

  it("is working from when the run was claimed, not from when it was asked for", () => {
    const running = session({ activity: "working", requestedAt: at(1), runStartedAt: at(2) });
    expect(rowStatus(running, NOW)).toEqual({ kind: "working", since: at(2) });
    // An API older than the field: still Working, with no clock rather than a wrong one.
    expect(rowStatus(session({ activity: "working", requestedAt: at(1) }), NOW)).toEqual({
      kind: "working",
      since: null,
    });
  });

  it("is failed when the session needs attention", () => {
    expect(rowStatus(session({ activity: "attention" }), NOW)?.kind).toBe("failed");
  });

  it("is done only while a finished turn has not been looked at", () => {
    const finished = { activity: "completed" as const, activityAt: at(5), turnFinishedAt: at(5) };
    expect(rowStatus(session(finished, { readAt: at(10) }), NOW)?.kind).toBe("done");
    expect(rowStatus(session(finished, { readAt: at(1) }), NOW)).toBeNull();
  });

  it("is not done because pull request feedback arrived, which finishes nothing", () => {
    const feedback = session(
      { activity: "completed", activityAt: at(1), turnFinishedAt: at(30), pendingFeedback: 1 },
      { readAt: at(10) },
    );
    expect(rowStatus(feedback, NOW)).toBeNull();
  });

  it("is done when somebody marked the session unread", () => {
    expect(rowStatus(session({}, { unread: true }), NOW)?.kind).toBe("done");
  });

  it("is nothing for an idle session somebody has read", () => {
    expect(rowStatus(session(), NOW)).toBeNull();
  });
});

describe("Woke", () => {
  it("is a snooze that has run out and has not been looked at since", () => {
    const woke = session({}, { snoozedUntil: at(5), readAt: at(30) });
    expect(isWoke(woke, NOW)).toBe(true);
    expect(rowStatus(woke, NOW)?.kind).toBe("woke");
    // Not yet woken, read since it woke, or never snoozed: none of these is Woke.
    expect(isWoke(session({}, { snoozedUntil: at(-5) }), NOW)).toBe(false);
    expect(isWoke(session({}, { snoozedUntil: at(5), readAt: at(1) }), NOW)).toBe(false);
    expect(isWoke(session(), NOW)).toBe(false);
  });

  it("is not Woke once it has been settled, and gives way to work and failure", () => {
    expect(isWoke(session({}, { snoozedUntil: at(5), doneAt: at(1) }), NOW)).toBe(false);
    const failed = session({ activity: "attention" }, { snoozedUntil: at(5) });
    expect(rowStatus(failed, NOW)?.kind).toBe("failed");
  });

  it("does not recede, so the eye finds a row that came back", () => {
    expect(recedes({ kind: "woke" }, false)).toBe(false);
  });
});

describe("seenChange", () => {
  it("acknowledges the newest activity of an unread session", () => {
    const unread = session({ activityAt: at(4), turnFinishedAt: at(5) }, { readAt: at(10) });
    expect(seenChange(unread, NOW)).toEqual({ kind: "read", at: at(4), unread: false });
  });

  it("acknowledges the wake as well, so a woken session stops saying Woke", () => {
    const woke = session({ activityAt: at(60) }, { snoozedUntil: at(5), readAt: at(60) });
    expect(seenChange(woke, NOW)).toEqual({ kind: "read", at: at(5), unread: false });
  });

  it("sends nothing for a session already read", () => {
    expect(
      seenChange(session({ activityAt: at(5), turnFinishedAt: at(5) }, { readAt: at(1) }), NOW),
    ).toBeNull();
  });
});

describe("finishedInBackground", () => {
  const working = (over: Partial<SessionSummary> = {}) =>
    session({ activity: "working", runStartedAt: at(2), ...over });
  // What each row had finished as of the last list it was idle on, from one list.
  const settle = (rows: SessionSummary[]) => settledFinishes(undefined, rows);
  const finish = (row: SessionSummary, minutesAgo = 0): SessionSummary => ({
    ...row,
    activity: "completed",
    activityAt: at(minutesAgo),
    turnFinishedAt: at(minutesAgo),
  });

  it("names a session whose turn finished since the last list, unread and not watched", () => {
    const watched = working();
    const other = working();
    const finished = finishedInBackground(
      settle([watched, other]),
      [watched, finish(other)],
      new Set([watched.projectId]),
      NOW,
    );
    expect(finished.map((row) => row.projectId)).toEqual([other.projectId]);
  });

  // Every session open since the last list counts as watched, not only the one open now: a turn
  // can finish on screen and the reader switch away before the list that shows it arrives.
  it("never names a session the reader had open since the last list", () => {
    const left = working();
    const now = working();
    const viewed = new Set([left.projectId, now.projectId]);
    expect(
      finishedInBackground(settle([left, now]), [finish(left), finish(now)], viewed, NOW),
    ).toEqual([]);
  });

  // The job runs on after a turn — verification, repair turns — and each turn moves the finish
  // time. Only the end of the whole job is news, once, when the row stops working.
  it("names nothing still working or queued, and names it once the job ends", () => {
    const running = working();
    const midJob = { ...finish(running, 1), activity: "working" as const };
    expect(finishedInBackground(settle([running]), [midJob], new Set(), NOW)).toEqual([]);
    const requeued = { ...finish(running, 1), activity: "queued" as const };
    expect(finishedInBackground(settle([running]), [requeued], new Set(), NOW)).toEqual([]);
    const meanwhile = settledFinishes(settle([running]), [midJob]);
    expect(finishedInBackground(meanwhile, [finish(running, 0)], new Set(), NOW)).toHaveLength(1);
  });

  // `job.completed` is written while the job still holds its lease: publishing the pull request
  // and photographing the app come after it. A list read in between shows the final finish on a
  // row that still says Working; the toast must still come once the row goes idle.
  it("names a job whose last finish was listed while it still said Working", () => {
    const before = finish(working(), 30);
    const ended = { ...finish(before, 0), activity: "working" as const };
    const baseline = settledFinishes(settle([before]), [ended]);
    expect(finishedInBackground(baseline, [finish(before, 0)], new Set(), NOW)).toHaveLength(1);
  });

  // Publishing a verified job runs and ends without a new finish: the row leaving Working is not
  // news unless something finished, even when the reader has marked it unread meanwhile.
  it("names nothing that stops working without its finish moving", () => {
    const idle = finish(working(), 5);
    const publishing = { ...idle, activity: "working" as const };
    const settled = { ...idle, navigation: NavigationSchema.parse({ unread: true }) };
    const baseline = settledFinishes(settle([idle]), [publishing]);
    expect(finishedInBackground(baseline, [settled], new Set(), NOW)).toEqual([]);
  });

  // A session that turned up mid-watch already working — started in another tab — has finished
  // nothing the reader knew of, so its first finish is news.
  it("names the first finish of a session first listed while it worked", () => {
    const known = finish(working(), 30);
    const started = working();
    const baseline = settledFinishes(settle([known]), [known, started]);
    expect(finishedInBackground(baseline, [known, finish(started)], new Set(), NOW)).toHaveLength(
      1,
    );
  });

  it("names nothing archived", () => {
    const running = working();
    const archived = {
      ...finish(running),
      navigation: NavigationSchema.parse({ archivedAt: at(0) }),
    };
    expect(finishedInBackground(settle([running]), [archived], new Set(), NOW)).toEqual([]);
  });

  // A failure is not "finished": its row says Failed in red, and a green check would contradict it.
  it("names nothing whose turn failed", () => {
    const broken = working();
    const failed = { ...finish(broken), activity: "attention" as const };
    expect(finishedInBackground(settle([broken]), [failed], new Set(), NOW)).toEqual([]);
  });

  it("names a second finished turn on a session that had finished before", () => {
    const earlier = finish(working(), 10);
    const later = finish(earlier, 0);
    expect(finishedInBackground(settle([earlier]), [later], new Set(), NOW)).toHaveLength(1);
  });

  // The first list after a load is not news: everything in it finished before the reader came.
  it("names nothing on the first list, or for a session it had not seen", () => {
    const row = finish(working());
    expect(finishedInBackground(undefined, [row], new Set(), NOW)).toEqual([]);
    expect(finishedInBackground(settle([]), [row], new Set(), NOW)).toEqual([]);
  });

  it("names nothing whose finished turn did not move, or was already read elsewhere", () => {
    const done = finish(working(), 5);
    expect(
      finishedInBackground(settle([done]), [{ ...done, activityAt: at(0) }], new Set(), NOW),
    ).toEqual([]);
    const running = working();
    const readInAnotherTab = {
      ...finish(running),
      navigation: NavigationSchema.parse({ readAt: at(0) }),
    };
    expect(finishedInBackground(settle([running]), [readInAnotherTab], new Set(), NOW)).toEqual([]);
  });
});

describe("rangeBetween", () => {
  it("is every id from one end to the other, in list order, whichever end comes first", () => {
    expect(rangeBetween(["a", "b", "c", "d"], "c", "a")).toEqual(["a", "b", "c"]);
    expect(rangeBetween(["a", "b", "c", "d"], "b", "d")).toEqual(["b", "c", "d"]);
    expect(rangeBetween(["a", "b"], "gone", "b")).toEqual(["b"]);
  });
});

describe("isUnread", () => {
  it("compares the newest finished turn with the read watermark", () => {
    expect(isUnread(session({ turnFinishedAt: at(5) }))).toBe(true);
    expect(isUnread(session({ turnFinishedAt: at(5) }, { readAt: at(1) }))).toBe(false);
    expect(isUnread(session({ activityAt: at(5) }))).toBe(false);
    expect(isUnread(session({}, { unread: true }))).toBe(true);
    expect(isUnread(session())).toBe(false);
  });
});

describe("the card's third line", () => {
  it("names the model without its vendor, and the line counts as T3 does", () => {
    expect(modelLabel("openai/gpt-5.6-luna")).toBe("gpt-5.6-luna");
    expect(modelLabel("openai/gpt-oss-120b:free")).toBe("gpt-oss-120b");
    expect(modelLabel("claude-sonnet-5")).toBe("claude-sonnet-5");
    expect(modelLabel(null)).toBeNull();
    expect(diffLabel({ added: 412, removed: 88 })).toEqual({ added: "+412", removed: "−88" });
    expect(diffLabel({ added: 12_400, removed: 0 })).toEqual({ added: "+12.4k", removed: "−0" });
    expect(diffLabel(null)).toBeNull();
  });
});

describe("recedes", () => {
  it("dims what needs nothing from the reader, and never the open session", () => {
    expect(recedes(null, false)).toBe(true);
    expect(recedes({ kind: "working", since: at(1) }, false)).toBe(true);
    expect(recedes({ kind: "queued" }, false)).toBe(true);
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
