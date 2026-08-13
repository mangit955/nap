import type { ProjectSummaryPayload } from "@nap/shared/projects-protocol";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Sidebar } from "./sidebar.tsx";

/**
 * The rail down the left of the dashboard.
 *
 * Queried by role and accessible name throughout — the sidebar is a landmark full of navigation,
 * and a link a screen reader cannot name is the failure worth catching here.
 */

function project(over: Partial<ProjectSummaryPayload> = {}): ProjectSummaryPayload {
  return {
    projectId: "3e0fbc41-6f5d-4a8e-ab9c-4d5e6f708192",
    name: "Habit Builder",
    status: "ready",
    sandboxId: "sbx_1",
    updatedAt: "2026-08-12T10:00:00.000Z",
    sessionIds: [],
    ...over,
  };
}

function show(props: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  const handlers = {
    onScopeChange: vi.fn(),
    onSearch: vi.fn(),
    onNewProject: vi.fn(),
    onApiKey: vi.fn(),
    onSignOut: vi.fn(),
  };

  render(
    <Sidebar
      name="Manas"
      email="manas@example.com"
      scope="all"
      counts={{ all: 3, running: 1, "put-away": 2 }}
      recents={[project()]}
      keyHint={undefined}
      {...handlers}
      {...props}
    />,
  );

  return handlers;
}

describe("the dashboard sidebar", () => {
  it("is a navigation landmark with a name, since the page has two", () => {
    show();

    expect(screen.getByRole("navigation", { name: /dashboard/i })).toBeInTheDocument();
  });

  it("offers the three scopes with their counts", () => {
    show();

    expect(screen.getByRole("button", { name: "All projects, 3" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Running, 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Put away, 2" })).toBeInTheDocument();
  });

  it("says which scope is showing, in a way that is not only a colour", () => {
    show({ scope: "running" });

    expect(screen.getByRole("button", { name: "Running, 1" })).toHaveAttribute(
      "aria-current",
      "true",
    );
    expect(screen.getByRole("button", { name: "All projects, 3" })).not.toHaveAttribute(
      "aria-current",
    );
  });

  it("changes the scope when one is picked", () => {
    const { onScopeChange } = show();

    fireEvent.click(screen.getByRole("button", { name: "Put away, 2" }));

    expect(onScopeChange).toHaveBeenCalledWith("put-away");
  });

  it("hands search to the field that does the searching", () => {
    // The sidebar has no input of its own: two boxes filtering one grid is two answers that can
    // disagree, so this button moves the cursor to the grid's.
    const { onSearch } = show();

    fireEvent.click(screen.getByRole("button", { name: /search/i }));

    expect(onSearch).toHaveBeenCalled();
  });

  it("links each recent project to its workspace", () => {
    show({ recents: [project({ projectId: "abc", name: "Todo Landing Page" })] });

    expect(screen.getByRole("link", { name: "Todo Landing Page" })).toHaveAttribute(
      "href",
      "/p/abc",
    );
  });

  it("leaves out the recents heading when there is nothing recent", () => {
    // An empty heading is a promise the page does not keep.
    show({ recents: [] });

    expect(screen.queryByRole("heading", { name: /recents/i })).not.toBeInTheDocument();
  });

  it("names the person signed in, and offers the way out", () => {
    const { onSignOut } = show();

    expect(screen.getByText("manas@example.com")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /sign out/i }));

    expect(onSignOut).toHaveBeenCalled();
  });

  it("starts a new project from the rail", () => {
    const { onNewProject } = show();

    fireEvent.click(screen.getByRole("button", { name: /new project/i }));

    expect(onNewProject).toHaveBeenCalled();
  });

  it("offers somewhere to put an API key, and says there is none yet", () => {
    const { onApiKey } = show({ keyHint: undefined });

    fireEvent.click(screen.getByRole("button", { name: "Add your API key" }));

    expect(onApiKey).toHaveBeenCalled();
  });

  it("shows which key is in use, so nobody has to open it to find out", () => {
    // The state is the thing people come to this entry to check. A label that reads the same
    // either way makes them open it every time.
    show({ keyHint: "sk-or-…4f2a" });

    expect(screen.getByRole("button", { name: "API key · sk-or-…4f2a" })).toBeInTheDocument();
  });
});
