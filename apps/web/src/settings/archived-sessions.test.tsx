import { NavigationSchema, type SessionSummary } from "@nap/shared/session-navigation";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { ArchivedSessions } from "./archived-sessions.tsx";

it("lists only archived sessions and restores through navigation", () => {
  const archived: SessionSummary = {
    projectId: "archived",
    name: "Old work",
    status: "ready",
    sandboxId: null,
    sessionIds: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    navigation: NavigationSchema.parse({ archivedAt: new Date().toISOString() }),
    revision: 0,
    activity: "ready",
    activityAt: null,
    requestedAt: null,
    repository: null,
    branch: null,
    pullRequest: null,
    pendingFeedback: 0,
  };
  const live = {
    ...archived,
    projectId: "active",
    name: "Current work",
    navigation: NavigationSchema.parse({}),
  };
  const restore = vi.fn();
  const view = render(<ArchivedSessions sessions={[archived, live]} onRestore={restore} />);
  expect(screen.queryByRole("link", { name: "Current work" })).toBeNull();
  expect(screen.getByRole("link", { name: "Old work" })).toHaveAttribute("href", "/p/archived");
  fireEvent.click(screen.getByRole("button", { name: "Restore Old work" }));
  expect(restore).toHaveBeenCalledWith("archived");
  view.rerender(
    <ArchivedSessions
      sessions={[{ ...archived, navigation: NavigationSchema.parse({}) }, live]}
      onRestore={restore}
    />,
  );
  expect(screen.getByText("No archived sessions.")).toBeInTheDocument();
});
