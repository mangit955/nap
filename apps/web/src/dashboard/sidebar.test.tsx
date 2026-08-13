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

/**
 * The account's own actions live behind the name now, so every case about them opens it first.
 *
 * A press is the only way it opens — see the case below about hover.
 */
function openAccountMenu() {
  fireEvent.click(screen.getByRole("button", { name: /Manas/ }));
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

  it("marks signing out as in flight, and holds the button while it is", () => {
    // The one action in this rail that is neither instant nor visible: nothing on the page
    // changes until the redirect lands, so an unmarked slow sign-out reads as a dead button.
    show({ signingOut: true });
    openAccountMenu();

    const item = screen.getByRole("menuitem", { name: "Sign out" });
    expect(item).toHaveAttribute("aria-busy", "true");
    expect(item).toBeDisabled();
    // Reached by class, as the spinner is `aria-hidden` and has no role to query. `aria-busy`
    // above is the half a screen reader gets; this is the half everyone else gets.
    expect(item.querySelector(".nap-spin")).not.toBeNull();
  });

  it("says nothing about being busy when it is not", () => {
    show();
    openAccountMenu();

    const item = screen.getByRole("menuitem", { name: "Sign out" });
    expect(item).not.toHaveAttribute("aria-busy");
    expect(item).toBeEnabled();
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

  it("names the person signed in, and offers the way out behind their name", () => {
    const { onSignOut } = show();

    // The name and email stay on the rail; only the actions moved.
    expect(screen.getByText("manas@example.com")).toBeInTheDocument();
    openAccountMenu();
    fireEvent.click(screen.getByRole("menuitem", { name: /sign out/i }));

    expect(onSignOut).toHaveBeenCalled();
  });

  it("keeps the account's actions shut until they are asked for", () => {
    // Signing out sat one careless click from Dashboard when it was a rail item. Behind the name
    // it is two deliberate ones, and the rail goes back to listing places rather than verbs.
    show();

    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByRole("menuitem", { name: /sign out/i })).toBeNull();
  });

  it("stays shut when the pointer merely passes over it", () => {
    // A menu that opens on hover opens when nobody asked, over the recents somebody is reading.
    show();

    fireEvent.pointerEnter(screen.getByRole("button", { name: /Manas/ }).parentElement as Element);

    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("says it has a menu, which hovering cannot", () => {
    // A pointer-only menu is unreachable by keyboard and unusable on a touch screen. These two
    // attributes are what make the trigger a control rather than a decorated name.
    show();

    const trigger = screen.getByRole("button", { name: /Manas/ });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    openAccountMenu();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("closes on Escape and gives focus back to the name", () => {
    // Focus left on an element that has just stopped existing is focus on `<body>`, and the next
    // Tab starts again from the top of the page.
    show();
    openAccountMenu();

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("button", { name: /Manas/ })).toHaveFocus();
  });

  it("starts a new project from the rail", () => {
    const { onNewProject } = show();

    fireEvent.click(screen.getByRole("button", { name: /new project/i }));

    expect(onNewProject).toHaveBeenCalled();
  });

  it("offers somewhere to put an API key, and says there is none yet", () => {
    const { onApiKey } = show({ keyHint: undefined });
    openAccountMenu();

    fireEvent.click(screen.getByRole("menuitem", { name: "Add your API key" }));

    expect(onApiKey).toHaveBeenCalled();
  });

  it("shows which key is in use, so nobody has to open it to find out", () => {
    // The state is the thing people come to this entry to check. A label that reads the same
    // either way makes them open it every time.
    show({ keyHint: "sk-or-…4f2a" });
    openAccountMenu();

    expect(screen.getByRole("menuitem", { name: "API key · sk-or-…4f2a" })).toBeInTheDocument();
  });
});
