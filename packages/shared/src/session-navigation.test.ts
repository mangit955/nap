import { expect, it } from "vitest";
import { NavigationSchema, type SessionSummary, sessionSection } from "./session-navigation.ts";

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
