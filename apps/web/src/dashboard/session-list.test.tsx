import { NavigationSchema, type SessionSummary } from "@nap/shared/session-navigation";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SessionList } from "./session-list.tsx";

const row = (name: string): SessionSummary => ({
  projectId: crypto.randomUUID(),
  name,
  status: "ready",
  sandboxId: "sandbox",
  sessionIds: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  navigation: NavigationSchema.parse({}),
  revision: 0,
  activity: "completed",
  activityAt: null,
  requestedAt: null,
  repository: "example/storefront",
  branch: "nap/header",
  pullRequest: null,
  pendingFeedback: 0,
});
it("shows truthful activity, preserves the selected row through filtering, and offers keyboard reorder", () => {
  const a = row("Fix header");
  const b = row("Add menu");
  a.navigation.position = 0;
  b.navigation.position = 1;
  const change = vi.fn();
  const reorder = vi.fn();
  const view = render(
    <SessionList
      sessions={[a, b]}
      activeProjectId={a.projectId}
      scope="all"
      query=""
      repository=""
      showArchived={false}
      onChange={change}
      onReorder={reorder}
    />,
  );
  expect(screen.getAllByText("Completed")).toHaveLength(2);
  expect(screen.queryByText("Working")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Session actions for Fix header" }));
  fireEvent.click(screen.getByRole("button", { name: "Move down" }));
  expect(reorder).toHaveBeenCalledWith(
    expect.objectContaining({
      rows: [
        { projectId: b.projectId, revision: 0 },
        { projectId: a.projectId, revision: 0 },
      ],
    }),
  );
  view.rerender(
    <SessionList
      sessions={[a, b]}
      activeProjectId={a.projectId}
      scope="all"
      query="unmatched"
      repository=""
      showArchived={false}
      onChange={change}
      onReorder={reorder}
    />,
  );
  expect(screen.getByRole("link", { name: /Fix header/ })).toHaveAttribute("aria-current", "page");
});
