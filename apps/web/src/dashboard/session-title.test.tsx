import { NavigationSchema, type SessionSummary } from "@nap/shared/session-navigation";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { Sidebar } from "./sidebar.tsx";

const session = (titling: boolean): SessionSummary => ({
  projectId: "00000000-0000-4000-8000-000000000031",
  name: "Habit Tracker",
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
  repository: null,
  branch: null,
  pullRequest: null,
  pendingFeedback: 0,
  runStartedAt: null,
  turnFinishedAt: null,
  diff: null,
  model: null,
  titling,
});

function sidebar(row: SessionSummary, regenerateTitle = vi.fn(async () => {})) {
  return (
    <Sidebar
      navigation={{
        projects: [row],
        status: "ready",
        actionError: undefined,
        undoAction: undefined,
        apply: vi.fn(async () => true),
        change: vi.fn(),
        undo: vi.fn(),
        reload: vi.fn(),
        dismissUndo: vi.fn(),
        rename: vi.fn(),
        remove: vi.fn(),
        close: vi.fn(),
        search: vi.fn(async () => ({ ok: true as const, value: { results: [] } })),
        regenerateTitle,
      }}
      name="Reader"
      email={undefined}
      recents={[]}
      keyHint={undefined}
      onNewProject={vi.fn()}
      onApiKey={vi.fn()}
      onSignOut={vi.fn()}
    />
  );
}

it("asks for a new title from the row's menu, and dims the name while it is written", () => {
  const regenerateTitle = vi.fn(async () => {});
  const view = render(sidebar(session(false), regenerateTitle));
  const row = screen.getByRole("link", { name: /Habit Tracker/ });
  fireEvent.contextMenu(row, { clientX: 40, clientY: 80 });
  const menu = screen.getByRole("menu", { name: "Actions for Habit Tracker" });
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Regenerate title" }));
  expect(regenerateTitle).toHaveBeenCalledExactlyOnceWith(session(false).projectId);

  view.rerender(sidebar(session(true), regenerateTitle));
  const name = screen.getByText("Habit Tracker");
  expect(name).toHaveAttribute("aria-busy", "true");
  expect(name).toHaveTextContent("Habit Tracker (writing a title)");
  fireEvent.contextMenu(screen.getByRole("link", { name: /Habit Tracker/ }), {
    clientX: 40,
    clientY: 80,
  });
  expect(
    within(screen.getByRole("menu", { name: "Actions for Habit Tracker" })).queryByRole(
      "menuitem",
      { name: "Regenerate title" },
    ),
  ).toBeNull();
});
