import { NavigationSchema, type SessionSummary } from "@nap/shared/session-navigation";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Dashboard } from "./dashboard.tsx";
import { SessionList } from "./session-list.tsx";
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

const portfolio: SessionSummary = {
  projectId: "00000000-0000-4000-8000-000000000001",
  name: "Portfolio",
  status: "ready",
  sandboxId: "sandbox",
  sessionIds: [],
  createdAt: "2026-10-23T00:00:00.000Z",
  updatedAt: "2026-10-23T00:00:00.000Z",
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
};

/** The mobile drawer open on one session, with that session's context menu open over it. */
function openSessionActions() {
  render(
    <Dashboard
      sidebar={
        <nav aria-label="Sessions">
          <SessionList
            sessions={[portfolio]}
            query=""
            repository=""
            onApply={vi.fn(async () => true)}
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
  // A touch screen's way in: it has no right-click.
  fireEvent.click(screen.getByRole("button", { name: "More actions for Portfolio" }));
  return screen.getByRole("menu", { name: "Actions for Portfolio" });
}

it("keeps the context menu's arrow keys to the menu, and Tab leaves it for the row", () => {
  openSessionActions();
  expect(screen.getByRole("menuitem", { name: "Pin" })).toHaveFocus();
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "ArrowDown" });
  expect(screen.getByRole("menuitem", { name: "Settle" })).toHaveFocus();
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Tab" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(screen.getByRole("link", { name: /Portfolio/ })).toHaveFocus();
  expect(screen.getByRole("button", { name: "Close sessions" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
});

it("closes the session action menu before the mobile drawer on Escape", () => {
  openSessionActions();
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Close sessions" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect(screen.getByRole("link", { name: /Portfolio/ })).toHaveFocus();
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
  expect(screen.getByRole("button", { name: "Open sessions" })).toHaveFocus();
});

it("leaves the delete dialog's keys to the dialog while mobile sessions stays open", () => {
  openSessionActions();
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete" }));
  const dialog = screen.getByRole("dialog", { name: "Delete session?" });
  const cancel = within(dialog).getByRole("button", { name: "Cancel" });
  cancel.focus();
  expect(fireEvent.keyDown(cancel, { key: "Tab" })).toBe(true);
  expect(fireEvent.keyDown(cancel, { key: "Escape" })).toBe(true);
  expect(screen.getByRole("button", { name: "Close sessions" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
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

it("keeps mobile sessions open when an earlier document listener consumes Escape", () => {
  const consumeEscape = (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
  };
  // Next delegates React events to document, where stopPropagation leaves later listeners alive.
  document.addEventListener("keydown", consumeEscape, { once: true });
  try {
    render(<Dashboard sidebar={interactiveSidebar()} hero={<p>Composer</p>} />);
    const trigger = screen.getByRole("button", { name: "Open sessions" });
    fireEvent.click(trigger);
    const link = screen.getByRole("link", { name: "nap dashboard" });
    expect(link).toHaveFocus();

    const escapeEvent = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    fireEvent(link, escapeEvent);
    expect(escapeEvent.defaultPrevented).toBe(true);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(link).toHaveFocus();
    expect(screen.getByRole("main", { hidden: true })).toHaveAttribute("inert");

    fireEvent.keyDown(link, { key: "Escape" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
    expect(screen.getByRole("main")).not.toHaveAttribute("inert");
  } finally {
    document.removeEventListener("keydown", consumeEscape);
  }
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

it("hides thread controls under the mobile sessions drawer and restores them on close", () => {
  render(
    <Dashboard
      sidebar={<nav aria-label="Sessions">Sessions</nav>}
      hero={<p>Composer</p>}
      details={<button type="button">Toggle thread details panel</button>}
    />,
  );
  const toggle = screen.getByRole("button", { name: "Toggle thread details panel" });
  fireEvent.click(screen.getByRole("button", { name: "Open sessions" }));
  expect(screen.queryByRole("button", { name: "Toggle thread details panel" })).toBeNull();
  expect(toggle.closest("[inert]")).not.toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Close sessions" }));
  expect(screen.getByRole("button", { name: "Toggle thread details panel" })).toBeVisible();
  expect(toggle.closest("[inert]")).toBeNull();
});

describe("native sidebar persistence defaults", () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it("restores and updates the real app's existing width and collapse keys", () => {
    localStorage.setItem("nap.sidebar.width", "320");
    localStorage.setItem("nap.sidebar.collapsed", "true");
    const view = render(<Dashboard sidebar={<p>Sessions</p>} hero={<p>Composer</p>} />);

    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    const handle = screen.getByRole("separator", { name: "Sidebar width" });
    expect(handle).toHaveAttribute("aria-valuenow", "320");
    expect(localStorage.getItem("nap.sidebar.collapsed")).toBe("false");
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(localStorage.getItem("nap.sidebar.width")).toBe("304");
    fireEvent.click(screen.getByRole("button", { name: "Collapse sidebar" }));
    expect(localStorage.getItem("nap.sidebar.collapsed")).toBe("true");

    view.unmount();
    render(<Dashboard sidebar={<p>Sessions</p>} hero={<p>Composer</p>} />);
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(screen.getByRole("separator", { name: "Sidebar width" })).toHaveAttribute(
      "aria-valuenow",
      "304",
    );
  });
});
