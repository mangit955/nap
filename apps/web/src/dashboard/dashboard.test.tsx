import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { Dashboard } from "./dashboard.tsx";
import { SessionActions } from "./session-actions.tsx";
import { Sidebar } from "./sidebar.tsx";

/**
 * The frame: a rail on the left, with scrolling confined to the content column rather than the
 * full dashboard page.
 *
 * Structural only, so it can be mounted without a session, a router or a network — the same
 * split `landing.tsx` and every pane in the workspace use.
 */

function show(fading = false) {
  render(
    <Dashboard
      fading={fading}
      sidebar={<nav aria-label="Dashboard">rail</nav>}
      hero={<p>greeting</p>}
      grid={<p>projects</p>}
    />,
  );
}

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function () {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

function openSessionActions() {
  render(
    <Dashboard
      sidebar={
        <nav aria-label="Sessions">
          <SessionActions
            name="Portfolio"
            onRename={vi.fn()}
            onClose={vi.fn()}
            onDelete={vi.fn()}
          />
        </nav>
      }
      hero={<button type="button">Composer</button>}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open sessions" }));
  fireEvent.click(screen.getByRole("button", { name: "Session actions for Portfolio" }));
}

it("keeps every portalled session action reachable by Tab inside mobile sessions", () => {
  const rects = vi
    .spyOn(HTMLElement.prototype, "getClientRects")
    .mockReturnValue(
      Object.assign([new DOMRect(0, 0, 100, 30)], { item: () => new DOMRect(0, 0, 100, 30) }),
    );
  try {
    openSessionActions();
    expect(screen.getByRole("button", { name: "Rename" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Tab" });
    expect(screen.getByRole("button", { name: "Put away workspace" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Tab" });
    expect(screen.getByRole("button", { name: "Delete project" })).toHaveFocus();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Tab", shiftKey: true });
    expect(screen.getByRole("button", { name: "Put away workspace" })).toHaveFocus();
  } finally {
    rects.mockRestore();
  }
});

it("closes the session action menu before the mobile drawer on Escape", () => {
  openSessionActions();
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  expect(screen.queryByRole("button", { name: "Rename" })).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Close sessions" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect(screen.getByRole("button", { name: "Session actions for Portfolio" })).toHaveFocus();
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  expect(screen.getByRole("button", { name: "Open sessions" })).toHaveFocus();
});

it("leaves the rename dialog's keys to the dialog while mobile sessions stays open", () => {
  openSessionActions();
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  const input = screen.getByRole("textbox", { name: "Session name" });
  input.focus();
  expect(fireEvent.keyDown(input, { key: "Tab" })).toBe(true);
  expect(fireEvent.keyDown(input, { key: "Escape" })).toBe(true);
  expect(screen.getByRole("button", { name: "Close sessions" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  const dialog = screen.getByRole("dialog", { name: "Rename session" });
  if (!(dialog instanceof HTMLDialogElement)) throw new Error("Expected the native dialog");
  act(() => dialog.close());
  expect(screen.getByRole("button", { name: "Session actions for Portfolio" })).toHaveFocus();
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  expect(screen.getByRole("button", { name: "Open sessions" })).toHaveFocus();
});

describe("the dashboard frame", () => {
  it("puts the rail and the page in two landmarks a reader can move between", () => {
    show();

    expect(screen.getByRole("navigation", { name: /dashboard/i })).toBeInTheDocument();
    expect(screen.getByRole("main")).toBeInTheDocument();
  });

  it("renders the hero above the grid inside the main column", () => {
    show();

    const main = screen.getByRole("main");
    expect(main).toHaveTextContent("greeting");
    expect(main).toHaveTextContent("projects");
    // The rail is beside the page, not inside it: a nav nested in `main` is not a landmark
    // anybody can skip to.
    expect(main).not.toHaveTextContent("rail");
  });

  it("keeps page overflow clipped while the content column remains the scroll region", () => {
    show();

    expect(screen.getByRole("main")).toHaveClass("overflow-y-auto");
    expect(screen.getByRole("main")).toHaveClass("nap-scroll-hidden");
    expect(screen.getByRole("main").parentElement).toHaveClass("overflow-hidden");
  });

  it("fades the frame while signing out", () => {
    show(true);

    const frame = screen.getByRole("main").parentElement;
    expect(frame).toHaveAttribute("data-signing-out", "true");
    expect(frame).toHaveClass("opacity-60");
    expect(frame).toHaveAttribute("aria-busy", "true");
  });
});

it("collapses and restores the sidebar without leaving the dashboard", () => {
  show();
  const frame = screen.getByRole("main").parentElement;
  fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
  expect(frame).toHaveAttribute("data-sidebar-collapsed", "true");
  fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
  expect(frame).toHaveAttribute("data-sidebar-collapsed", "false");
});

it("dismisses mobile navigation from the backdrop", () => {
  show();
  fireEvent.click(screen.getByRole("button", { name: "Open sessions" }));
  expect(screen.getByRole("button", { name: "Close sessions" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  fireEvent.click(screen.getByRole("button", { name: "Close navigation" }));
  expect(screen.getByRole("button", { name: "Open sessions" })).toHaveFocus();
});

function interactiveSidebar(onNewProject = vi.fn()) {
  return (
    <Sidebar
      name="Reader"
      email={undefined}
      recents={[]}
      onNewProject={onNewProject}
      onApiKey={() => {}}
      keyHint={undefined}
      onSignOut={() => {}}
    />
  );
}

it("moves focus into mobile sessions and Escape immediately returns it to the trigger", () => {
  render(
    <Dashboard sidebar={interactiveSidebar()} hero={<button type="button">Composer</button>} />,
  );
  const trigger = screen.getByRole("button", { name: "Open sessions" });
  trigger.focus();
  fireEvent.click(trigger);
  expect(screen.getByRole("link", { name: "nap dashboard" })).toHaveFocus();
  expect(screen.getByRole("main", { hidden: true })).toHaveAttribute("inert");
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  expect(screen.getByRole("button", { name: "Open sessions" })).toHaveFocus();
  expect(screen.getByRole("main")).not.toHaveAttribute("inert");
});

it("closes mobile sessions when New session is chosen", () => {
  const onNewProject = vi.fn();
  render(<Dashboard sidebar={interactiveSidebar(onNewProject)} hero={<p>Composer</p>} />);
  fireEvent.click(screen.getByRole("button", { name: "Open sessions" }));
  fireEvent.click(screen.getAllByRole("button", { name: "New session" })[0]!);
  expect(onNewProject).toHaveBeenCalledOnce();
  expect(screen.getByRole("button", { name: "Open sessions" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});

it("includes source filter and Settings in the real mobile sidebar's Tab order", () => {
  const rects = vi
    .spyOn(HTMLElement.prototype, "getClientRects")
    .mockReturnValue(
      Object.assign([new DOMRect(0, 0, 100, 30)], { item: () => new DOMRect(0, 0, 100, 30) }),
    );
  try {
    render(<Dashboard sidebar={interactiveSidebar()} hero={<p>Composer</p>} />);
    fireEvent.click(screen.getByRole("button", { name: "Open sessions" }));
    const reached = new Set<Element | null>();
    for (let index = 0; index < 30; index++) {
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Tab" });
      reached.add(document.activeElement);
    }
    expect(reached.has(screen.getByRole("button", { name: "Filter by source" }))).toBe(true);
    expect(reached.has(screen.getByRole("button", { name: "Settings" }))).toBe(true);
    expect(reached.has(screen.getByRole("button", { name: "Close sessions" }))).toBe(true);
  } finally {
    rects.mockRestore();
  }
});

it("resizes the shared sidebar by keyboard and restores its width", () => {
  localStorage.clear();
  const view = render(<Dashboard sidebar={<p>Sessions</p>} hero={<p>Composer</p>} />);
  const handle = screen.getByRole("separator", { name: "Sidebar width" });
  expect(handle).toHaveAttribute("aria-valuenow", "256");
  fireEvent.keyDown(handle, { key: "ArrowRight" });
  expect(handle).toHaveAttribute("aria-valuenow", "272");
  view.unmount();
  render(<Dashboard sidebar={<p>Sessions</p>} hero={<p>Composer</p>} />);
  expect(screen.getByRole("separator", { name: "Sidebar width" })).toHaveAttribute(
    "aria-valuenow",
    "272",
  );
  localStorage.clear();
});
