import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Dashboard } from "./dashboard.tsx";
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
      scope="all"
      counts={{ all: 0, running: 0, "put-away": 0 }}
      recents={[]}
      onScopeChange={() => {}}
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
