import type { ProjectSummaryPayload } from "@nap/shared/projects-protocol";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Dashboard } from "./dashboard.tsx";
import { Sidebar } from "./sidebar.tsx";

/**
 * What the palette offers on the dashboard, from the components that own each handler: the frame
 * owns Toggle sidebar, the sidebar owns New session and the sessions. The palette's own keys and
 * drawing are in `palette/command-palette.test.tsx`; this is the wiring.
 *
 * jsdom has `<dialog>` without its methods, and its platform is not a Mac, so the chord is Ctrl+K.
 */
beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

afterEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
});

const habit: ProjectSummaryPayload = {
  projectId: "3e0fbc41-6f5d-4a8e-ab9c-4d5e6f708192",
  name: "Habit Builder",
  status: "ready",
  sandboxId: "sbx_1",
  updatedAt: "2026-08-12T10:00:00.000Z",
  sessionIds: [],
};

function show() {
  const handlers = { onNewProject: vi.fn(), onSelectProject: vi.fn() };
  const view = render(
    <Dashboard
      sidebar={
        <Sidebar
          name="Reader"
          email={undefined}
          recents={[habit]}
          keyHint={undefined}
          onApiKey={vi.fn()}
          onSignOut={vi.fn()}
          {...handlers}
        />
      }
      hero={<p>greeting</p>}
    />,
  );
  const frame = () => view.container.querySelector<HTMLElement>(".dashboard-frame");
  return { ...handlers, frame };
}

const chord = () => fireEvent.keyDown(window, { key: "k", code: "KeyK", ctrlKey: true });
const pick = (name: string) => {
  chord();
  fireEvent.click(screen.getByRole("option", { name: new RegExp(`^${name}`) }));
};

describe("the dashboard's commands", () => {
  it("offers New session, Toggle sidebar and every session, and nothing the dashboard cannot do", () => {
    show();
    chord();
    expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
      "New session",
      "Toggle sidebar",
      expect.stringMatching(/^Habit Builder/),
    ]);
  });

  it("runs each through its owner's handler", () => {
    const { onNewProject, onSelectProject, frame } = show();
    pick("New session");
    expect(onNewProject).toHaveBeenCalledOnce();
    pick("Habit Builder");
    expect(onSelectProject).toHaveBeenCalledWith(habit.projectId);
    pick("Toggle sidebar");
    expect(frame()?.dataset.sidebarCollapsed).toBe("true");
  });

  it("keeps focus on the toggle when it collapses a sidebar that held it", () => {
    show();
    screen.getByRole("button", { name: "New session" }).focus();
    pick("Toggle sidebar");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Expand sidebar" }));
  });

  it("puts the drawer away before a command runs, giving focus back to its trigger", () => {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query) =>
        ({
          matches: true,
          media: query,
          addEventListener() {},
          removeEventListener() {},
        }) as unknown as MediaQueryList,
    );
    const { onNewProject, frame } = show();
    fireEvent.click(screen.getByRole("button", { name: "Open sessions" }));
    expect(frame()?.dataset.navigationOpen).toBe("true");
    pick("New session");
    expect(onNewProject).toHaveBeenCalledOnce();
    expect(frame()?.dataset.navigationOpen).toBe("false");
    // Toggle sidebar on a phone is the drawer: open it, then close it again.
    pick("Toggle sidebar");
    expect(frame()?.dataset.navigationOpen).toBe("true");
    pick("Toggle sidebar");
    expect(frame()?.dataset.navigationOpen).toBe("false");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Open sessions" }));
  });
});
