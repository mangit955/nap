import type { ProjectSummaryPayload } from "@nap/shared/projects-protocol";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectGrid } from "./project-grid.tsx";

/**
 * The lower half of the dashboard: a search field, the scope tabs, and a card per project.
 *
 * The grid renders what it is given — the filtering itself is `filters.ts`, tested without a
 * DOM — so what these assert is the wiring and the three states a list can be in.
 */

function project(over: Partial<ProjectSummaryPayload> = {}): ProjectSummaryPayload {
  return {
    projectId: "3e0fbc41-6f5d-4a8e-ab9c-4d5e6f708192",
    name: "Habit Builder",
    status: "ready",
    sandboxId: "sbx_1",
    updatedAt: new Date().toISOString(),
    sessionIds: [],
    ...over,
  };
}

function show(props: Partial<Parameters<typeof ProjectGrid>[0]> = {}) {
  const handlers = {
    onQueryChange: vi.fn(),
    onScopeChange: vi.fn(),
    onOpen: vi.fn(),
    onClose: vi.fn(),
    onDelete: vi.fn(),
  };

  render(
    <ProjectGrid
      projects={[project()]}
      status="ready"
      actionError={undefined}
      query=""
      scope="all"
      counts={{ all: 1, running: 1, "put-away": 0 }}
      {...handlers}
      {...props}
    />,
  );

  return handlers;
}

describe("the project grid", () => {
  it("draws a card per project, named so it can be opened", () => {
    show({ projects: [project({ name: "Todo Landing Page" })] });

    expect(screen.getByRole("button", { name: "Todo Landing Page" })).toBeInTheDocument();
  });

  it("opens the one that was clicked", () => {
    const { onOpen } = show({ projects: [project({ projectId: "abc", name: "Todo" })] });

    fireEvent.click(screen.getByRole("button", { name: "Todo" }));

    expect(onOpen).toHaveBeenCalledWith("abc");
  });

  it("says what a project is doing in words, never only a colour", () => {
    show({ projects: [project({ sandboxId: null, status: "idle" })] });

    expect(screen.getByText(/put away/)).toBeInTheDocument();
  });

  it("offers to put away only what is actually running", () => {
    show({ projects: [project({ sandboxId: null, status: "idle" })] });

    expect(screen.queryByRole("button", { name: /^close$/i })).not.toBeInTheDocument();
  });

  it("asks before deleting, because the bytes go too", () => {
    const { onDelete } = show();

    fireEvent.click(screen.getByRole("button", { name: /^delete$/i }));
    expect(onDelete).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /yes, delete/i }));
    expect(onDelete).toHaveBeenCalledWith("3e0fbc41-6f5d-4a8e-ab9c-4d5e6f708192");
  });

  it("passes what was typed in the search field up", () => {
    const { onQueryChange } = show();

    fireEvent.change(screen.getByRole("searchbox", { name: /search/i }), {
      target: { value: "habit" },
    });

    expect(onQueryChange).toHaveBeenCalledWith("habit");
  });

  it("switches scope from the tabs above the grid", () => {
    const { onScopeChange } = show();

    fireEvent.click(screen.getByRole("tab", { name: /running/i }));

    expect(onScopeChange).toHaveBeenCalledWith("running");
    expect(screen.getByRole("tab", { name: /all/i })).toHaveAttribute("aria-selected", "true");
  });

  it("explains an empty grid differently when a search emptied it", () => {
    // "Nothing here yet" under a search box with a word in it is a lie about the account.
    show({ projects: [], query: "habit" });

    expect(screen.getByText(/no projects match/i)).toBeInTheDocument();
  });

  it("invites a first project when there are none at all", () => {
    show({ projects: [], counts: { all: 0, running: 0, "put-away": 0 } });

    expect(screen.getByText(/nothing here yet/i)).toBeInTheDocument();
  });

  it("says which scope is empty rather than claiming the account is", () => {
    // "Nothing here yet" in front of somebody with nine projects, none of them running, is a
    // lie about their account — the same mistake as printing it under a search that matched
    // nothing.
    show({ projects: [], scope: "running", counts: { all: 4, running: 0, "put-away": 4 } });

    expect(screen.getByText(/nothing is running/i)).toBeInTheDocument();
    expect(screen.queryByText(/nothing here yet/i)).not.toBeInTheDocument();
  });

  it("says the list is on its way rather than showing an empty one", () => {
    show({ projects: [], status: "loading" });

    expect(screen.getByText(/loading your projects/i)).toBeInTheDocument();
    expect(screen.queryByText(/nothing here yet/i)).not.toBeInTheDocument();
  });

  it("says the server could not be reached", () => {
    show({ projects: [], status: "error" });

    expect(screen.getByText(/could not reach the server/i)).toBeInTheDocument();
  });

  it("reports a refused action where the person who tried it will look", () => {
    show({ actionError: "a turn is running in this project" });

    expect(screen.getByRole("alert")).toHaveTextContent("a turn is running in this project");
  });
});
