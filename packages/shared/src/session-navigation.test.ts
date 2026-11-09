import { expect, it } from "vitest";
import {
  applyNavigationChange,
  NavigationSchema,
  type SessionSummary,
  sessionSection,
} from "./session-navigation.ts";

const item = (): SessionSummary => ({
  projectId: crypto.randomUUID(),
  name: "Example",
  sessionIds: [],
  status: "ready",
  sandboxId: "sandbox",
  updatedAt: "2026-10-20T10:00:00Z",
  createdAt: "2026-10-20T10:00:00Z",
  navigation: NavigationSchema.parse({}),
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
});
it("separates organization from execution and wakes snoozes without running work", () => {
  const session = item();
  expect(sessionSection(session, Date.now())).toBe("active");
  session.navigation.pinned = true;
  expect(sessionSection(session, Date.now())).toBe("pinned");
  session.navigation.snoozedUntil = "2026-10-21T10:00:00Z";
  expect(sessionSection(session, Date.parse("2026-10-20T10:00:00Z"))).toBe("snoozed");
  expect(sessionSection(session, Date.parse("2026-10-22T10:00:00Z"))).toBe("pinned");
  session.navigation.doneAt = "2026-10-22T10:00:00Z";
  expect(sessionSection(session, Date.now())).toBe("done");
  session.requestedAt = "2026-10-23T10:00:00Z";
  expect(sessionSection(session, Date.parse("2026-10-24T10:00:00Z"))).toBe("pinned");
  session.navigation.archivedAt = "2026-10-24T10:00:00Z";
  expect(sessionSection(session, Date.now())).toBe("archived");
  session.activity = "working";
  expect(sessionSection(session, Date.now())).toBe("pinned");
});

it("applies each change the way the store persists it, without touching the input", () => {
  const now = "2026-10-20T12:00:00.000Z";
  const base = NavigationSchema.parse({ position: 3, snoozedUntil: "2026-10-21T00:00:00.000Z" });
  const pinned = applyNavigationChange(base, { kind: "pin", pinned: true }, now);
  // Pinning moves a row to another list, so the place it had in the old one means nothing.
  expect(pinned).toMatchObject({ pinned: true, position: null });
  expect(base).toMatchObject({ pinned: false, position: 3 });
  // Settling and snoozing exclude each other: each clears the other's timestamp.
  expect(applyNavigationChange(base, { kind: "done", value: true }, now)).toMatchObject({
    doneAt: now,
    snoozedUntil: null,
  });
  const settled = NavigationSchema.parse({ doneAt: now });
  expect(
    applyNavigationChange(settled, { kind: "snooze", until: "2026-10-22T00:00:00.000Z" }, now),
  ).toMatchObject({ doneAt: null, snoozedUntil: "2026-10-22T00:00:00.000Z" });
  expect(applyNavigationChange(settled, { kind: "done", value: false }, now).doneAt).toBeNull();
  expect(applyNavigationChange(base, { kind: "archive", value: true }, now).archivedAt).toBe(now);
  expect(applyNavigationChange(base, { kind: "archive", value: false }, now).archivedAt).toBeNull();
  const restored = NavigationSchema.parse({ pinned: true, readAt: now });
  expect(applyNavigationChange(base, { kind: "restore", navigation: restored }, now)).toEqual(
    restored,
  );
});

it("moves the read watermark forward only, so a late read cannot hide newer activity", () => {
  const now = "2026-10-20T12:00:00.000Z";
  const read = NavigationSchema.parse({ readAt: "2026-10-20T11:00:00.000Z", unread: true });
  const earlier = applyNavigationChange(
    read,
    { kind: "read", at: "2026-10-20T10:00:00.000Z", unread: false },
    now,
  );
  expect(earlier).toMatchObject({ readAt: "2026-10-20T11:00:00.000Z", unread: false });
  const later = applyNavigationChange(
    read,
    { kind: "read", at: "2026-10-20T11:30:00.000Z", unread: false },
    now,
  );
  expect(later.readAt).toBe("2026-10-20T11:30:00.000Z");
  // Marking unread keeps the watermark: "unread" is a flag over it, not a rewind of it.
  expect(
    applyNavigationChange(
      read,
      { kind: "read", at: "2026-10-20T11:30:00.000Z", unread: true },
      now,
    ),
  ).toMatchObject({ readAt: "2026-10-20T11:00:00.000Z", unread: true });
});
