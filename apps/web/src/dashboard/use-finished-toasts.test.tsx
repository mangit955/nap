import { NavigationSchema, type SessionSummary } from "@nap/shared/session-navigation";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { Toaster } from "../ui/toast.tsx";
import { LEFT_GRACE_MS, useFinishedToasts } from "./use-finished-toasts.ts";

let counter = 0;
function row(name: string): SessionSummary {
  counter += 1;
  return {
    projectId: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
    name,
    status: "ready",
    sandboxId: null,
    sessionIds: [],
    createdAt: "2026-11-28T10:00:00.000Z",
    updatedAt: "2026-11-28T10:00:00.000Z",
    navigation: NavigationSchema.parse({}),
    revision: 0,
    activity: "working",
    activityAt: null,
    requestedAt: "2026-11-28T10:00:00.000Z",
    repository: null,
    branch: null,
    pullRequest: null,
    pendingFeedback: 0,
    runStartedAt: "2026-11-28T10:00:00.000Z",
    turnFinishedAt: null,
    diff: null,
    model: null,
    titling: false,
  };
}
const finish = (session: SessionSummary): SessionSummary => ({
  ...session,
  activity: "completed",
  activityAt: "2026-11-28T10:05:00.000Z",
  turnFinishedAt: "2026-11-28T10:05:00.000Z",
});

function Harness(props: {
  projects: SessionSummary[];
  openProjectId: string | undefined;
  open: (id: string) => void;
  ready?: boolean;
}) {
  useFinishedToasts(props.projects, props.ready ?? true, props.openProjectId, props.open);
  return null;
}

it("raises a toast naming a session that finished out of sight, whose Open goes there", async () => {
  const watched = row("Seeded notes app");
  const other = row("Fix empty-state copy");
  const open = vi.fn();
  render(<Toaster />);
  const view = render(
    <Harness projects={[watched, other]} openProjectId={watched.projectId} open={open} />,
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  view.rerender(
    <Harness projects={[watched, finish(other)]} openProjectId={watched.projectId} open={open} />,
  );
  const toast = await screen.findByRole("dialog", { name: "Session finished" });
  expect(toast).toHaveAccessibleDescription("Fix empty-state copy");
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  expect(open).toHaveBeenCalledExactlyOnceWith(other.projectId);
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("raises nothing for the session being viewed, nor for the list it first loads", async () => {
  const watched = row("Seeded notes app");
  const open = vi.fn();
  render(<Toaster />);
  const view = render(
    <Harness projects={[]} openProjectId={watched.projectId} open={open} ready={false} />,
  );
  view.rerender(<Harness projects={[watched]} openProjectId={watched.projectId} open={open} />);
  view.rerender(
    <Harness projects={[finish(watched)]} openProjectId={watched.projectId} open={open} />,
  );
  const settled = finish(row("Finished before the page loaded"));
  view.rerender(
    <Harness projects={[finish(watched), settled]} openProjectId={watched.projectId} open={open} />,
  );
  await act(() => Promise.resolve());
  expect(screen.queryByRole("dialog")).toBeNull();
});

// The turn finishes on screen, and the reader moves to another session before the list showing
// it arrives: they watched it finish, so it is not news. Every render here hands in a new array,
// as the sidebar's own read-mark does on a switch, so leaving is not forgotten by a new list.
it("raises nothing for a session left moments before the list showing its finish", async () => {
  const left = row("Left behind");
  const next = row("Next");
  const open = vi.fn();
  render(<Toaster />);
  const view = render(
    <Harness projects={[left, next]} openProjectId={left.projectId} open={open} />,
  );
  view.rerender(<Harness projects={[left, next]} openProjectId={next.projectId} open={open} />);
  view.rerender(
    <Harness projects={[finish(left), next]} openProjectId={next.projectId} open={open} />,
  );
  await act(() => Promise.resolve());
  expect(screen.queryByRole("dialog")).toBeNull();
});

// The dashboard and the workspace each hold their own list. Opening a session from the dashboard
// swaps one for the other, and a turn that finishes before the workspace's first list arrives
// would otherwise be on no list "before".
it("carries what it last saw from the dashboard into the workspace", async () => {
  const opened = row("Opened");
  const other = row("Still working");
  const open = vi.fn();
  render(<Toaster />);
  const dashboard = render(
    <Harness projects={[opened, other]} openProjectId={undefined} open={open} />,
  );
  dashboard.unmount();
  const workspace = render(
    <Harness projects={[]} openProjectId={opened.projectId} open={open} ready={false} />,
  );
  workspace.rerender(
    <Harness projects={[opened, finish(other)]} openProjectId={opened.projectId} open={open} />,
  );
  expect(
    await screen.findByRole("dialog", { name: "Session finished" }),
  ).toHaveAccessibleDescription("Still working");
});

it("goes nowhere when Open is pressed for a session that has since been deleted", async () => {
  const watched = row("Watched");
  const doomed = row("Deleted while its toast was up");
  const open = vi.fn();
  render(<Toaster />);
  const view = render(
    <Harness projects={[watched, doomed]} openProjectId={watched.projectId} open={open} />,
  );
  view.rerender(
    <Harness projects={[watched, finish(doomed)]} openProjectId={watched.projectId} open={open} />,
  );
  await screen.findByRole("dialog", { name: "Session finished" });
  view.rerender(<Harness projects={[watched]} openProjectId={watched.projectId} open={open} />);
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  expect(open).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("names a session the reader left once the grace has passed", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const left = row("Left a while ago");
    const next = row("Next");
    const open = vi.fn();
    render(<Toaster />);
    const view = render(
      <Harness projects={[left, next]} openProjectId={left.projectId} open={open} />,
    );
    view.rerender(<Harness projects={[left, next]} openProjectId={next.projectId} open={open} />);
    vi.setSystemTime(Date.now() + LEFT_GRACE_MS);
    view.rerender(
      <Harness projects={[finish(left), next]} openProjectId={next.projectId} open={open} />,
    );
    expect(await screen.findByRole("dialog", { name: "Session finished" })).toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});

// New session takes the reader from the workspace to the dashboard: the session they were on is
// left as surely as by a switch, though nothing in the workspace is still mounted to say so.
it("raises nothing for a session left by leaving the workspace, moments before its finish shows", async () => {
  const watched = row("Watched to the end");
  const open = vi.fn();
  render(<Toaster />);
  const workspace = render(
    <Harness projects={[watched]} openProjectId={watched.projectId} open={open} />,
  );
  workspace.unmount();
  render(<Harness projects={[finish(watched)]} openProjectId={undefined} open={open} />);
  await act(() => Promise.resolve());
  expect(screen.queryByRole("dialog")).toBeNull();
});
