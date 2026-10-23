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
      query=""
      repository=""
      onChange={change}
      onReorder={reorder}
    />,
  );
  expect(screen.queryByRole("status")).toBeNull();
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
      query="unmatched"
      repository=""
      onChange={change}
      onReorder={reorder}
    />,
  );
  expect(screen.getByRole("link", { name: /Fix header/ })).toHaveAttribute("aria-current", "page");
});

it("keeps the current session visible without opening its shelf, persists expansion, and pages settled rows", () => {
  localStorage.clear();
  const sessions = Array.from({ length: 38 }, (_, index) => ({
    ...row(`Settled ${index}`),
    navigation: NavigationSchema.parse({
      doneAt: new Date(Date.now() - index * 1000).toISOString(),
    }),
  }));
  const props = {
    sessions,
    activeProjectId: sessions[37]?.projectId,
    query: "",
    repository: "",
    ownerId: "shelf-reader",
  };
  const view = render(<SessionList {...props} />);
  const shelf = screen.getByRole("button", { name: "Settled (38)" });
  expect(shelf).toHaveAttribute("aria-expanded", "false");
  expect(screen.getAllByRole("link")).toHaveLength(1);
  expect(screen.getByRole("link", { name: /Settled 37/ })).toHaveAttribute("aria-current", "page");
  fireEvent.click(shelf);
  expect(screen.getAllByRole("link")).toHaveLength(11);
  fireEvent.click(screen.getByRole("button", { name: "Show 25 more" }));
  expect(screen.getAllByRole("link")).toHaveLength(36);
  fireEvent.click(screen.getByRole("button", { name: "Show 25 more" }));
  expect(screen.getAllByRole("link")).toHaveLength(38);
  expect(screen.queryByRole("button", { name: "Show 25 more" })).toBeNull();
  view.unmount();
  render(<SessionList {...props} />);
  expect(screen.getByRole("button", { name: "Settled (38)" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  localStorage.clear();
});

it("omits archived sessions even if selected, and filters Scratch as a source", () => {
  const archived = {
    ...row("Archived work"),
    navigation: NavigationSchema.parse({ archivedAt: new Date().toISOString() }),
  };
  const scratch = { ...row("Sketch an idea"), repository: null };
  render(
    <SessionList
      sessions={[archived, scratch, row("Repository work")]}
      activeProjectId={archived.projectId}
      query=""
      repository="scratch"
    />,
  );
  expect(screen.queryByRole("link", { name: /Archived work/ })).toBeNull();
  expect(screen.queryByRole("link", { name: /Repository work/ })).toBeNull();
  expect(screen.getByRole("link", { name: /Sketch an idea/ })).toBeInTheDocument();
});

it("snoozes with a preset, settles, and edits a title inline without following its link", () => {
  vi.useFakeTimers();
  try {
    const session = row("Fix header");
    const onChange = vi.fn();
    const onRename = vi.fn();
    render(
      <SessionList
        sessions={[session]}
        query=""
        repository=""
        onChange={onChange}
        onRename={onRename}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Snooze Fix header" }));
    fireEvent.click(screen.getByRole("menuitem", { name: /In 1 hour/ }));
    expect(onChange).toHaveBeenLastCalledWith(session.projectId, {
      kind: "snooze",
      until: new Date(Date.now() + 3600000).toISOString(),
    });
    fireEvent.click(screen.getByRole("button", { name: "Settle Fix header" }));
    expect(onChange).toHaveBeenLastCalledWith(session.projectId, { kind: "done", value: true });
    const link = screen.getByRole("link", { name: /Fix header/ });
    expect(fireEvent.click(link, { detail: 1 })).toBe(false);
    fireEvent.doubleClick(link);
    vi.advanceTimersByTime(350);
    const input = screen.getByRole("textbox", { name: "Session name" });
    fireEvent.change(input, { target: { value: "Updated title" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledExactlyOnceWith(session.projectId, "Updated title");
    fireEvent.doubleClick(screen.getByRole("link", { name: /Fix header/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Session name" }), {
      target: { value: "Discard this" },
    });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Session name" }), { key: "Escape" });
    expect(onRename).toHaveBeenCalledTimes(1);
  } finally {
    vi.useRealTimers();
  }
});

it("shows working and failed states, and Done only until completion has been read", () => {
  const work = {
    ...row("Building"),
    activity: "working" as const,
    requestedAt: new Date().toISOString(),
  };
  const failed = { ...row("Broken"), activity: "attention" as const };
  const done = { ...row("Finished"), activityAt: new Date().toISOString() };
  const view = render(<SessionList sessions={[work, failed, done]} query="" repository="" />);
  expect(screen.getAllByRole("status").map((element) => element.textContent)).toEqual(
    expect.arrayContaining(["Working", "Failed", "Done"]),
  );
  view.rerender(
    <SessionList
      sessions={[{ ...done, navigation: NavigationSchema.parse({ readAt: done.activityAt }) }]}
      query=""
      repository=""
    />,
  );
  expect(screen.queryByRole("status")).toBeNull();
});
