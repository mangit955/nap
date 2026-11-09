import {
  NavigationSchema,
  type SessionSummary,
  sessionSection,
} from "@nap/shared/session-navigation";
import { expect, it } from "vitest";
import { applyPending, type PendingOp, withPending } from "./navigation-overlay.ts";

const row = (name: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  projectId: crypto.randomUUID(),
  name,
  status: "ready",
  sandboxId: "sandbox",
  sessionIds: [],
  createdAt: "2026-10-20T10:00:00.000Z",
  updatedAt: "2026-10-20T10:00:00.000Z",
  navigation: NavigationSchema.parse({}),
  revision: 4,
  activity: "completed",
  activityAt: null,
  requestedAt: null,
  repository: null,
  branch: null,
  pullRequest: null,
  pendingFeedback: 0,
  ...extra,
});
const at = "2026-10-20T12:00:00.000Z";

it("draws each kind of pending action the way the server will answer it", () => {
  const a = row("A");
  const b = row("B", { navigation: NavigationSchema.parse({ pinned: true, position: 0 }) });
  const rows = [a, b];
  const change: PendingOp = {
    kind: "change",
    projectId: a.projectId,
    change: { kind: "done", value: true },
    at,
  };
  const settled = applyPending(rows, change);
  expect(settled[0]?.navigation.doneAt).toBe(at);
  expect(rows[0]?.navigation.doneAt).toBeNull();
  // The revision is the server's to move; drawing an action leaves it where the server put it.
  expect(settled[0]?.revision).toBe(4);
  expect(
    applyPending(rows, { kind: "rename", projectId: a.projectId, name: "Renamed" })[0]?.name,
  ).toBe("Renamed");
  expect(applyPending(rows, { kind: "remove", projectId: a.projectId })).toEqual([b]);
  expect(applyPending(rows, { kind: "close", projectId: a.projectId })[0]?.sandboxId).toBeNull();
  const reordered = applyPending(rows, {
    kind: "reorder",
    section: "active",
    projectIds: [a.projectId],
  });
  expect(reordered[0]?.navigation.position).toBe(0);
  expect(reordered[1]).toBe(b);
});

it("stamps a settle no earlier than the request it settles, whatever this clock says", () => {
  // A client clock behind the server's would otherwise stamp a time before the request,
  // and the row would stay in the inbox until the reply corrected it.
  const working = row("Ran recently", { requestedAt: "2026-10-20T12:00:05.000Z" });
  const [settled] = applyPending([working], {
    kind: "change",
    projectId: working.projectId,
    change: { kind: "done", value: true },
    at,
  });
  expect(settled && sessionSection(settled, Date.parse(at))).toBe("done");
});

it("folds pending actions in order and ignores one whose row has gone", () => {
  const a = row("A");
  const ops: PendingOp[] = [
    { kind: "change", projectId: a.projectId, change: { kind: "pin", pinned: true }, at },
    { kind: "change", projectId: crypto.randomUUID(), change: { kind: "pin", pinned: true }, at },
    { kind: "change", projectId: a.projectId, change: { kind: "pin", pinned: false }, at },
  ];
  expect(withPending([a], ops)[0]?.navigation.pinned).toBe(false);
  expect(withPending([a], ops.slice(0, 1))[0]?.navigation.pinned).toBe(true);
  expect(withPending([a], [])).toEqual([a]);
});
