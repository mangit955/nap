import { NavigationSchema, type SessionSummary } from "@nap/shared/session-navigation";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Dashboard } from "./dashboard.tsx";
import { SessionList } from "./session-list.tsx";
import { Sidebar } from "./sidebar.tsx";

const at = "2026-10-23T00:00:00.000Z";
const row = (name = "Review target"): SessionSummary => ({
  projectId: crypto.randomUUID(),
  name,
  status: "ready",
  sandboxId: null,
  sessionIds: [],
  createdAt: at,
  updatedAt: at,
  navigation: NavigationSchema.parse({}),
  revision: 0,
  activity: "completed",
  activityAt: null,
  requestedAt: null,
  repository: null,
  branch: null,
  pullRequest: null,
  pendingFeedback: 0,
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
});

it("UI-01 keeps the mobile drawer open while a first click is pending double-click detection", () => {
  vi.useFakeTimers();
  render(
    <Dashboard
      hero={<p>Workspace</p>}
      sidebar={<SessionList sessions={[row()]} query="" repository="" onRename={vi.fn()} />}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open sessions" }));
  expect(screen.getByRole("button", { name: "Close sessions" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  const link = screen.getByRole("link", { name: /Review target/ });
  expect(fireEvent.click(link, { detail: 1 })).toBe(false);
  // No timer has run and no navigation has been committed. A second pointer click still needs this row.
  expect(screen.getByRole("button", { name: /sessions$/ })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
});

it.each(["Enter", "Escape"])(
  "UI-02 restores row focus after inline rename finishes with %s",
  (key) => {
    render(<SessionList sessions={[row()]} query="" repository="" onRename={vi.fn()} />);
    fireEvent.doubleClick(screen.getByRole("link", { name: /Review target/ }));
    const input = screen.getByRole("textbox", { name: "Session name" });
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: "Replacement" } });
    fireEvent.keyDown(input, { key });
    expect(screen.queryByRole("textbox", { name: "Session name" })).toBeNull();
    expect(screen.getByRole("link", { name: /Review target/ })).toHaveFocus();
  },
);

it("UI-03 reveals the final selected row after persisted shelves have loaded", () => {
  localStorage.setItem(
    "nap.sidebar.shelves.review-owner",
    JSON.stringify({ settled: true, snoozed: false }),
  );
  const selected = {
    ...row("Selected settled row"),
    navigation: NavigationSchema.parse({ doneAt: at }),
  };
  const inbox = Array.from({ length: 20 }, (_, index) => row(`Inbox ${index}`));
  const scrolled: Element[] = [];
  const prior = Object.getOwnPropertyDescriptor(Element.prototype, "scrollIntoView");
  Object.defineProperty(Element.prototype, "scrollIntoView", {
    configurable: true,
    value: function (this: Element) {
      scrolled.push(this);
    },
  });
  try {
    const navigation = {
      projects: [...inbox, selected],
      status: "ready" as const,
      actionError: undefined,
      busyProjectId: undefined,
      undoAction: undefined,
      change: vi.fn(),
      undo: vi.fn(),
      reorder: vi.fn(),
      reload: vi.fn(),
      dismissUndo: vi.fn(),
      rename: vi.fn(),
      remove: vi.fn(),
      close: vi.fn(),
    };
    const props = {
      ownerId: "review-owner",
      activeProjectId: selected.projectId,
      navigation,
      name: "Reviewer",
      email: undefined,
      recents: [],
      keyHint: undefined,
      onNewProject: vi.fn(),
      onApiKey: vi.fn(),
      onSignOut: vi.fn(),
    };
    const view = render(<Sidebar {...props} />);
    expect(screen.getByRole("button", { name: "Settled (1)" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    const finalRow = screen.getByRole("link", { name: /Selected settled row/ });
    expect(finalRow).toHaveAttribute("aria-current", "page");
    // A scroll of a temporary row that is subsequently removed cannot reveal this final node.
    expect(scrolled.at(-1)).toBe(finalRow);
    expect(scrolled).toHaveLength(1);
    view.rerender(
      <Sidebar
        {...props}
        navigation={{
          ...navigation,
          projects: navigation.projects.map((session) => ({ ...session })),
        }}
      />,
    );
    expect(scrolled).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Settled (1)" }));
    const fallback = screen.getByRole("link", { name: /Selected settled row/ });
    expect(fallback).not.toBe(finalRow);
    expect(scrolled.at(-1)).toBe(fallback);
    expect(scrolled).toHaveLength(2);
  } finally {
    if (prior) Object.defineProperty(Element.prototype, "scrollIntoView", prior);
    else Reflect.deleteProperty(Element.prototype, "scrollIntoView");
  }
});

it("closes the drawer only when the deferred single click commits", async () => {
  vi.useFakeTimers();
  render(
    <Dashboard
      hero={<p>Workspace</p>}
      sidebar={<SessionList sessions={[row()]} query="" repository="" onRename={vi.fn()} />}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open sessions" }));
  const link = screen.getByRole("link", { name: /Review target/ });
  // jsdom can follow a fragment, but cannot load a new document.
  link.setAttribute("href", "#session");
  fireEvent.click(link, { detail: 1 });
  expect(screen.getByRole("button", { name: "Close sessions" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  await act(async () => {
    vi.advanceTimersByTime(301);
  });
  expect(screen.getByRole("button", { name: "Open sessions" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});

it("keeps a double-click rename in the drawer after the navigation timer expires", async () => {
  vi.useFakeTimers();
  const rename = vi.fn();
  render(
    <Dashboard
      hero={<p>Workspace</p>}
      sidebar={<SessionList sessions={[row()]} query="" repository="" onRename={rename} />}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Open sessions" }));
  const link = screen.getByRole("link", { name: /Review target/ });
  fireEvent.click(link, { detail: 1 });
  fireEvent.click(link, { detail: 2 });
  fireEvent.doubleClick(link);
  await act(async () => {
    vi.advanceTimersByTime(350);
  });
  expect(screen.getByRole("button", { name: "Close sessions" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  const input = screen.getByRole("textbox", { name: "Session name" });
  expect(input).toHaveFocus();
  fireEvent.keyDown(input, { key: "Escape" });
  expect(screen.getByRole("link", { name: /Review target/ })).toHaveFocus();
  expect(screen.getByRole("button", { name: "Close sessions" })).toHaveAttribute(
    "aria-expanded",
    "true",
  );
  expect(rename).not.toHaveBeenCalled();
});

it("keeps the drawer open when a document listener cancels ordinary navigation", async () => {
  render(<Dashboard hero={<p>Workspace</p>} sidebar={<a href="/dashboard">Dashboard</a>} />);
  fireEvent.click(screen.getByRole("button", { name: "Open sessions" }));
  const cancel = (event: MouseEvent) => event.preventDefault();
  document.addEventListener("click", cancel);
  try {
    await act(async () => {
      fireEvent.click(screen.getByRole("link", { name: "Dashboard" }));
    });
    expect(screen.getByRole("button", { name: "Close sessions" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
  } finally {
    document.removeEventListener("click", cancel);
  }
});

it("closes the drawer for ordinary keyboard navigation", async () => {
  render(<Dashboard hero={<p>Workspace</p>} sidebar={<a href="#destination">Destination</a>} />);
  fireEvent.click(screen.getByRole("button", { name: "Open sessions" }));
  await act(async () => {
    fireEvent.click(screen.getByRole("link", { name: "Destination" }), { detail: 0 });
  });
  expect(screen.getByRole("button", { name: "Open sessions" })).toHaveAttribute(
    "aria-expanded",
    "false",
  );
});

it.each(["link", "button"] as const)(
  "ignores %s activation outside the open drawer",
  async (role) => {
    render(
      <>
        <Dashboard hero={<p>Workspace</p>} sidebar={<a href="#session">Session</a>} />
        {role === "link" ? (
          <a href="#other">Other navigation</a>
        ) : (
          <button type="button" data-new-session>
            Other navigation
          </button>
        )}
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Open sessions" }));
    await act(async () => {
      fireEvent.click(screen.getByRole(role, { name: "Other navigation" }));
    });
    expect(screen.getByRole("button", { name: "Close sessions" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("link", { name: "Session" }));
    });
    expect(screen.getByRole("button", { name: "Open sessions" })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  },
);

it.each(["card", "settled", "snoozed"] as const)(
  "continues arrow navigation after Enter and Escape on a %s row",
  (shelf) => {
    localStorage.setItem(
      "nap.sidebar.shelves.local",
      JSON.stringify({ settled: true, snoozed: true }),
    );
    const navigation = NavigationSchema.parse(
      shelf === "settled"
        ? { doneAt: at }
        : shelf === "snoozed"
          ? { snoozedUntil: new Date(Date.now() + 60000).toISOString() }
          : {},
    );
    const first = { ...row("First"), navigation: { ...navigation, position: 0 } };
    const next = { ...row("Next"), navigation: { ...navigation, position: 1 } };
    const rename = vi.fn();
    render(<SessionList sessions={[first, next]} query="" repository="" onRename={rename} />);
    for (const key of ["Enter", "Escape"]) {
      fireEvent.doubleClick(screen.getByRole("link", { name: /First/ }));
      const input = screen.getByRole("textbox", { name: "Session name" });
      fireEvent.change(input, { target: { value: "Changed" } });
      fireEvent.keyDown(input, { key });
      const restored = screen.getByRole("link", { name: /First/ });
      expect(restored).toHaveFocus();
      fireEvent.keyDown(restored, { key: "ArrowDown" });
      expect(screen.getByRole("link", { name: /Next/ })).toHaveFocus();
    }
    expect(rename).toHaveBeenCalledExactlyOnceWith(first.projectId, "Changed");
  },
);

it.each(["card", "slim"])(
  "does not steal focus when leaving a %s editor for another control",
  (variant) => {
    localStorage.setItem("nap.sidebar.shelves.local", JSON.stringify({ settled: true }));
    const session = {
      ...row(),
      navigation: NavigationSchema.parse(variant === "slim" ? { doneAt: at } : {}),
    };
    const rename = vi.fn();
    render(
      <>
        <SessionList sessions={[session]} query="" repository="" onRename={rename} />
        <button type="button">Other control</button>
      </>,
    );
    fireEvent.doubleClick(screen.getByRole("link", { name: /Review target/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Session name" }), {
      target: { value: "Changed" },
    });
    const other = screen.getByRole("button", { name: "Other control" });
    // Tab and mouse focus both blur the field with this intentional destination.
    act(() => other.focus());
    expect(other).toHaveFocus();
    expect(screen.queryByRole("textbox", { name: "Session name" })).toBeNull();
    expect(rename).toHaveBeenCalledExactlyOnceWith(session.projectId, "Changed");
  },
);
