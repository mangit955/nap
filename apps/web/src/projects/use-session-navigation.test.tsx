import { NavigationSchema, type SessionSummary } from "@nap/shared/session-navigation";
import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useSessionNavigation } from "./use-session-navigation.ts";

it("reads all list pages, sends revision checked changes and Undo, and reports a stale save", async () => {
  const row: SessionSummary = {
    projectId: crypto.randomUUID(),
    name: "Example",
    status: "ready",
    sandboxId: null,
    sessionIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    navigation: NavigationSchema.parse({}),
    revision: 0,
    activity: "ready",
    activityAt: null,
    requestedAt: null,
    repository: "example/storefront",
    branch: null,
    pullRequest: null,
    pendingFeedback: 0,
  };
  const second = { ...row, projectId: crypto.randomUUID(), name: "Docs" };
  let stale = false;
  const fetchJson = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "PATCH") {
      if (stale)
        return Response.json({ error: "Session changed in another tab." }, { status: 409 });
      const body = JSON.parse(String(init.body));
      row.navigation =
        body.change.kind === "restore"
          ? body.change.navigation
          : { ...row.navigation, pinned: true };
      row.revision++;
      return Response.json({ navigation: row.navigation, revision: row.revision });
    }
    return Response.json(
      url.includes("?after=")
        ? { sessions: [second], next: null }
        : { sessions: [row], next: row.projectId },
    );
  });
  const { result } = renderHook(() => useSessionNavigation({ fetchJson }));
  await waitFor(() => expect(result.current.projects).toHaveLength(2));
  await act(async () => result.current.change(row.projectId, { kind: "pin", pinned: true }));
  expect(result.current.undoAction?.revision).toBe(1);
  await act(async () => result.current.undo());
  expect(row.navigation.pinned).toBe(false);
  stale = true;
  await act(async () => result.current.change(row.projectId, { kind: "pin", pinned: true }));
  expect(result.current.actionError).toMatch(/another tab/);
  expect(row.navigation.pinned).toBe(false);
});
