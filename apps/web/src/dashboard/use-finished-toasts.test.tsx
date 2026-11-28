import { NavigationSchema, type SessionSummary } from "@nap/shared/session-navigation";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { Toaster } from "../ui/toast.tsx";
import { useFinishedToasts } from "./use-finished-toasts.ts";

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
}) {
  useFinishedToasts(props.projects, props.openProjectId, props.open);
  return <Toaster />;
}

it("raises a toast naming a session that finished out of sight, whose Open goes there", async () => {
  const watched = row("Seeded notes app");
  const other = row("Fix empty-state copy");
  const open = vi.fn();
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
  const view = render(<Harness projects={[]} openProjectId={watched.projectId} open={open} />);
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
