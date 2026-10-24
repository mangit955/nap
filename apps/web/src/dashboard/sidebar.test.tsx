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
    onNewProject: vi.fn(),
    onApiKey: vi.fn(),
    onSignOut: vi.fn(),
  };

  render(
    <Sidebar
      name="Manas"
      email="manas@example.com"
      recents={[project()]}
      keyHint={undefined}
      {...handlers}
      {...props}
    />,
  );

  return handlers;
}

/**
 * The account's own actions live inside Settings, so every case about them opens it first.
 *
 * A press is the only way it opens — see the case below about hover.
 */
function openAccountMenu() {
  fireEvent.click(screen.getByRole("button", { name: "Settings" }));
}

describe("the dashboard sidebar", () => {
  it("restores scroll after asynchronous rows load only once", () => {
    sessionStorage.setItem("nap.sidebar.scroll", "4000");
    const props = {
      name: "Reader",
      email: undefined,
      recents: [],
      keyHint: undefined,
      onNewProject: vi.fn(),
      onApiKey: vi.fn(),
      onSignOut: vi.fn(),
    };
    const view = render(<Sidebar {...props} loading />);
    const list = screen.getByRole("region", { name: "Session list" });
    // Browsers clamp an offset to zero while the list contains only its loading placeholder.
    list.scrollTop = 0;
    fireEvent.scroll(list);
    expect(sessionStorage.getItem("nap.sidebar.scroll")).toBe("4000");
    view.rerender(<Sidebar {...props} recents={[project()]} />);
    expect(list.scrollTop).toBe(4000);
    list.scrollTop = 2200;
    fireEvent.scroll(list);
    view.rerender(<Sidebar {...props} recents={[project({ name: "Updated title" })]} />);
    expect(list.scrollTop).toBe(2200);
    sessionStorage.removeItem("nap.sidebar.scroll");
  });

  it("is a navigation landmark with a name, since the page has two", () => {
    show();

    expect(screen.getByRole("navigation", { name: /dashboard/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "nap dashboard" })).toHaveAttribute(
      "href",
      "/dashboard",
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

  it("searches the sessions in the sidebar", () => {
    show({
      recents: [
        project({ name: "Habit Builder" }),
        project({ projectId: "other", name: "Portfolio" }),
      ],
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Search sessions" }), {
      target: { value: "portfolio" },
    });
    expect(screen.getByRole("link", { name: /Portfolio/ })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Habit Builder/ })).not.toBeInTheDocument();
  });

  it("links each recent project to its workspace", () => {
    show({ recents: [project({ projectId: "abc", name: "Todo Landing Page" })] });

    expect(screen.getByRole("link", { name: /Todo Landing Page/ })).toHaveAttribute(
      "href",
      "/p/abc",
    );
  });

  it("leaves out the recents heading when there is nothing recent", () => {
    // An empty heading is a promise the page does not keep.
    show({ recents: [] });

    expect(screen.queryByRole("heading", { name: /recents/i })).not.toBeInTheDocument();
  });

  it("keeps account details and sign out inside Settings", () => {
    const { onSignOut } = show();

    // Account details are visible only while Settings is open.
    expect(screen.queryByText("manas@example.com")).toBeNull();
    openAccountMenu();
    expect(screen.getByText("manas@example.com")).toBeInTheDocument();
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

    fireEvent.pointerEnter(
      screen.getByRole("button", { name: "Settings" }).parentElement as Element,
    );

    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("says it has a menu, which hovering cannot", () => {
    // A pointer-only menu is unreachable by keyboard and unusable on a touch screen. These two
    // attributes are what make the trigger a control rather than a decorated name.
    show();

    const trigger = screen.getByRole("button", { name: "Settings" });
    expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    openAccountMenu();
    expect(trigger).toHaveAttribute("aria-expanded", "true");
  });

  it("closes on Escape and gives focus back to Settings", () => {
    // Focus left on an element that has just stopped existing is focus on `<body>`, and the next
    // Tab starts again from the top of the page.
    show();
    openAccountMenu();

    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("button", { name: "Settings" })).toHaveFocus();
  });

  it("starts a new project from the rail", () => {
    const { onNewProject } = show();

    fireEvent.click(screen.getAllByRole("button", { name: /new session/i })[0]!);

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

it("shows search immediately and filters Scratch through the searchable source picker", () => {
  show();
  expect(screen.getByRole("textbox", { name: "Search sessions" })).toBeInTheDocument();
  expect(screen.queryByRole("heading", { name: "Sessions" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Filter by source" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Search sources" }), {
    target: { value: "scr" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Scratch" }));
  expect(screen.getByRole("link", { name: /Habit Builder/ })).toBeInTheDocument();
  expect(screen.queryByRole("textbox", { name: "Search sources" })).toBeNull();
  expect(screen.getByRole("button", { name: "Filter by source" })).toHaveFocus();
  openAccountMenu();
  expect(screen.getByRole("menuitem", { name: "Archived sessions" })).toHaveAttribute(
    "href",
    "/settings/archived",
  );
  expect(screen.getByRole("menuitem", { name: "Providers" })).toHaveAttribute(
    "href",
    "/settings/providers",
  );
});
