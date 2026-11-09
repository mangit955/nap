import { NavigationSchema, type SessionSummary } from "@nap/shared/session-navigation";
import { describe, expect, it } from "vitest";
import {
  dropTarget,
  type ListItem,
  markerId,
  mergeOrder,
  planDrop,
  shelfMoveChanges,
} from "./sidebar-drop.ts";

const NOW = Date.parse("2026-10-23T12:00:00.000Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const session = (
  id: string,
  nav: Partial<SessionSummary["navigation"]> = {},
  extra: Partial<SessionSummary> = {},
): SessionSummary => ({
  projectId: id,
  name: id,
  status: "ready",
  sandboxId: null,
  sessionIds: [],
  createdAt: ago(600),
  updatedAt: ago(600),
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
  ...extra,
});

const items: ListItem[] = [
  { kind: "marker", marker: "pinned-header" },
  { kind: "row", id: "p1" },
  { kind: "marker", marker: "pinned-divider" },
  { kind: "row", id: "a1" },
  { kind: "row", id: "a2" },
  { kind: "marker", marker: "snoozed-header" },
  { kind: "row", id: "z1" },
  { kind: "marker", marker: "settled-header" },
  { kind: "row", id: "s1" },
];

describe("dropTarget", () => {
  it("reads the shelf a row lands on from the markers above where it lands", () => {
    expect(dropTarget(items, "a2", "p1")).toEqual({ shelf: "pinned", order: ["a2", "p1"] });
    expect(dropTarget(items, "p1", "a2")).toEqual({ shelf: "active", order: ["a1", "a2", "p1"] });
    expect(dropTarget(items, "a1", markerId("settled-header"))).toEqual({
      shelf: "settled",
      order: ["a1", "s1"],
    });
    expect(dropTarget(items, "s1", "a1")).toEqual({ shelf: "active", order: ["s1", "a1", "a2"] });
  });

  it("refuses a drop onto Snoozed, which needs a wake time a drop cannot give", () => {
    expect(dropTarget(items, "a1", "z1")).toBeNull();
  });

  it("refuses a drop onto nothing it knows", () => {
    expect(dropTarget(items, "a1", "elsewhere")).toBeNull();
    expect(dropTarget(items, markerId("pinned-divider"), "a1")).toBeNull();
  });
});

describe("shelfMoveChanges", () => {
  it("pins, settles, and brings rows back to the inbox", () => {
    expect(shelfMoveChanges(session("a"), "pinned", NOW)).toEqual([{ kind: "pin", pinned: true }]);
    expect(shelfMoveChanges(session("a"), "settled", NOW)).toEqual([{ kind: "done", value: true }]);
    expect(shelfMoveChanges(session("p", { pinned: true }), "active", NOW)).toEqual([
      { kind: "pin", pinned: false },
    ]);
    expect(shelfMoveChanges(session("s", { doneAt: ago(1) }), "active", NOW)).toEqual([
      { kind: "done", value: false },
    ]);
  });

  it("un-settles before it pins, and wakes a snoozed row rather than leaving it hidden", () => {
    expect(shelfMoveChanges(session("s", { doneAt: ago(1) }), "pinned", NOW)).toEqual([
      { kind: "done", value: false },
      { kind: "pin", pinned: true },
    ]);
    expect(shelfMoveChanges(session("z", { snoozedUntil: ago(-60) }), "active", NOW)).toEqual([
      { kind: "snooze", until: null },
    ]);
    // A settled row that was pinned before it settled goes back to the inbox when dropped there.
    expect(shelfMoveChanges(session("s", { doneAt: ago(1), pinned: true }), "active", NOW)).toEqual(
      [
        { kind: "done", value: false },
        { kind: "pin", pinned: false },
      ],
    );
  });

  it("cannot settle work in progress, and does nothing for a row already there", () => {
    const working = session("w", {}, { activity: "working", requestedAt: ago(1) });
    expect(shelfMoveChanges(working, "settled", NOW)).toBeNull();
    expect(shelfMoveChanges(working, "pinned", NOW)).toEqual([{ kind: "pin", pinned: true }]);
    expect(shelfMoveChanges(session("a"), "active", NOW)).toEqual([]);
  });
});

describe("mergeOrder", () => {
  it("places the moved row among rows a filter is hiding, beside the row it was dropped by", () => {
    // Drawn: a, m, c — b is hidden by a search. m goes before c, so after b.
    expect(mergeOrder(["a", "b", "c", "m"], ["a", "m", "c"], "m")).toEqual(["a", "b", "m", "c"]);
    expect(mergeOrder(["a", "b"], ["m", "a"], "m")).toEqual(["m", "a", "b"]);
    expect(mergeOrder(["a", "b"], ["a", "b", "m"], "m")).toEqual(["a", "b", "m"]);
  });
});

describe("planDrop", () => {
  const p1 = session("p1", { pinned: true, position: 0 });
  const a1 = session("a1");
  const a2 = session("a2");
  const s1 = session("s1", { doneAt: ago(1) });
  const all = [p1, a1, a2, s1];

  it("pins at the place it was dropped", () => {
    expect(planDrop(all, a2, { shelf: "pinned", order: ["a2", "p1"] }, NOW)).toEqual([
      { kind: "change", projectId: "a2", change: { kind: "pin", pinned: true } },
      { kind: "reorder", section: "pinned", projectIds: ["a2", "p1"] },
    ]);
  });

  it("settles on the Settled shelf, and un-settles into the inbox", () => {
    expect(planDrop(all, a1, { shelf: "settled", order: ["a1", "s1"] }, NOW)).toEqual([
      { kind: "change", projectId: "a1", change: { kind: "done", value: true } },
    ]);
    expect(planDrop(all, s1, { shelf: "active", order: ["s1", "a1", "a2"] }, NOW)).toEqual([
      { kind: "change", projectId: "s1", change: { kind: "done", value: false } },
      { kind: "reorder", section: "active", projectIds: ["s1", "a1", "a2"] },
    ]);
  });

  it("reorders within a shelf, and does nothing when nothing moved", () => {
    expect(planDrop(all, a2, { shelf: "active", order: ["a2", "a1"] }, NOW)).toEqual([
      { kind: "reorder", section: "active", projectIds: ["a2", "a1"] },
    ]);
    expect(planDrop(all, a1, { shelf: "active", order: ["a1", "a2"] }, NOW)).toEqual([]);
  });

  it("drops nothing when the move is not allowed", () => {
    const working = session("w", {}, { activity: "working", requestedAt: ago(1) });
    expect(planDrop([...all, working], working, { shelf: "settled", order: [] }, NOW)).toEqual([]);
  });
});
