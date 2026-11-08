import { NavigationSchema, type SessionSummary } from "@nap/shared/session-navigation";
import { expect, it } from "vitest";
import { type MenuItem, sessionMenuItems } from "./session-menu.ts";

const NOW = new Date("2026-10-23T12:00:00");
const session = (
  nav: Partial<SessionSummary["navigation"]> = {},
  extra: Partial<SessionSummary> = {},
): SessionSummary => ({
  projectId: crypto.randomUUID(),
  name: "Fix header",
  status: "ready",
  sandboxId: "sandbox",
  sessionIds: [],
  createdAt: NOW.toISOString(),
  updatedAt: NOW.toISOString(),
  navigation: NavigationSchema.parse(nav),
  revision: 0,
  activity: "ready",
  activityAt: null,
  requestedAt: null,
  repository: "example/storefront",
  branch: "nap/header",
  pullRequest: null,
  pendingFeedback: 0,
  ...extra,
});
const everything = { navigate: true, rename: true, putAway: true, remove: true };
const ids = (items: readonly MenuItem[]): string[] =>
  items.flatMap((item) => [item.id, ...(item.children ? ids(item.children) : [])]);

it("offers T3's grouping for an idle session in the inbox", () => {
  const items = sessionMenuItems({
    session: session(),
    now: NOW,
    can: everything,
    filteringBySource: false,
  });
  expect(ids(items)).toEqual([
    "pin",
    "settle",
    "snooze",
    "snooze:hour",
    "snooze:three-hours",
    "snooze:evening",
    "snooze:tomorrow",
    "snooze:next-week",
    "snooze:custom",
    "rename",
    "mark-unread",
    "filter-source",
    "copy",
    "copy-link",
    "copy-branch",
    "put-away",
    "archive",
    "delete",
  ]);
  const snooze = items.find((item) => item.id === "snooze");
  // Each preset says when it wakes.
  expect(snooze?.children?.[0]).toMatchObject({ label: "In 1 hour", detail: "1:00 PM" });
  expect(items.find((item) => item.id === "filter-source")?.label).toBe("Filter by storefront");
  expect(items.find((item) => item.id === "delete")?.destructive).toBe(true);
});

it("turns each toggle the other way for a pinned, settled, snoozed or unread session", () => {
  const pinned = sessionMenuItems({
    session: session({ pinned: true }, { activityAt: NOW.toISOString() }),
    now: NOW,
    can: everything,
    filteringBySource: true,
  });
  expect(ids(pinned)).toEqual(expect.arrayContaining(["unpin", "mark-read", "show-all-sources"]));
  const settled = sessionMenuItems({
    session: session({ doneAt: NOW.toISOString() }),
    now: NOW,
    can: everything,
    filteringBySource: false,
  });
  expect(ids(settled)).toContain("unsettle");
  const snoozed = sessionMenuItems({
    session: session({ snoozedUntil: new Date(NOW.getTime() + 3_600_000).toISOString() }),
    now: NOW,
    can: everything,
    filteringBySource: false,
  });
  expect(ids(snoozed)).toContain("wake");
  expect(ids(snoozed)).not.toContain("snooze");
});

it("offers Move up and Move down where there is a neighbour to swap with, as drag's keyboard twin", () => {
  const items = sessionMenuItems({
    session: session(),
    now: NOW,
    can: everything,
    filteringBySource: false,
    movable: { up: true, down: false },
  });
  expect(ids(items).slice(0, 4)).toEqual(["pin", "settle", "snooze", "snooze:hour"]);
  expect(ids(items)).toContain("move-up");
  expect(ids(items)).not.toContain("move-down");
});

it("leaves out what work in progress cannot do, rather than showing it dead", () => {
  const items = sessionMenuItems({
    session: session({}, { activity: "working", requestedAt: NOW.toISOString() }),
    now: NOW,
    can: everything,
    filteringBySource: false,
  });
  for (const id of ["settle", "snooze", "put-away", "archive", "delete"])
    expect(ids(items)).not.toContain(id);
  expect(ids(items)).toContain("pin");
});

it("offers only what the page can do, and no branch to copy when there is none", () => {
  const items = sessionMenuItems({
    session: session({}, { branch: null, sandboxId: null, repository: null }),
    now: NOW,
    can: { navigate: false, rename: false, putAway: true, remove: false },
    filteringBySource: false,
  });
  expect(ids(items)).toEqual(["filter-source", "copy", "copy-link"]);
  expect(items[0]?.label).toBe("Filter by Scratch");
});
