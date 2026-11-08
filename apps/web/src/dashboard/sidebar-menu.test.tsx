import {
  NavigationSchema,
  type SessionNavigation,
  type SessionSummary,
} from "@nap/shared/session-navigation";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useSessionNavigation } from "../projects/use-session-navigation.ts";
import { navigationServer } from "../testing/navigation-server.ts";
import { snoozePresets } from "./session-rows.ts";
import { Sidebar } from "./sidebar.tsx";

beforeAll(() => {
  // jsdom parses <dialog> and implements none of it (docs/GOTCHAS.md, Web and UI).
  HTMLDialogElement.prototype.showModal ??= function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function () {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});
afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const row = (
  name: string,
  navigation: Partial<SessionNavigation> = {},
  extra: Partial<SessionSummary> = {},
): SessionSummary => ({
  projectId: crypto.randomUUID(),
  name,
  status: "ready",
  sandboxId: "sandbox",
  sessionIds: [],
  createdAt: ago(600),
  updatedAt: ago(600),
  navigation: NavigationSchema.parse(navigation),
  revision: 0,
  activity: "completed",
  activityAt: null,
  requestedAt: ago(120),
  repository: "example/storefront",
  branch: "nap/fix-header",
  pullRequest: null,
  pendingFeedback: 0,
  ...extra,
});

/** The real hook against an in-memory server, inside the real sidebar. */
function Harness({
  server,
  onSelectProject,
}: {
  server: ReturnType<typeof navigationServer>;
  onSelectProject?: ((id: string) => void) | undefined;
}) {
  const navigation = useSessionNavigation({ fetchJson: server.fetchJson });
  return (
    <Sidebar
      navigation={navigation}
      ownerId="menu-reader"
      persistScroll={false}
      name="Reader"
      email={undefined}
      recents={[]}
      keyHint={undefined}
      onNewProject={vi.fn()}
      onApiKey={vi.fn()}
      onSignOut={vi.fn()}
      loading={navigation.status === "loading"}
      error={navigation.actionError}
      onRename={(id, name) => void navigation.rename(id, name)}
      onDelete={(id) => void navigation.remove(id)}
      onClose={(id) => void navigation.close(id)}
      onSelectProject={onSelectProject}
    />
  );
}

async function mount(rows: SessionSummary[], onSelectProject?: (id: string) => void) {
  const server = navigationServer(rows);
  render(<Harness server={server} onSelectProject={onSelectProject} />);
  await screen.findByRole("list", { name: "Inbox sessions" });
  return server;
}

const link = (name: string) => screen.getByRole("link", { name: new RegExp(name) });
function openMenu(name: string) {
  fireEvent.contextMenu(link(name), { clientX: 40, clientY: 80 });
  return screen.getByRole("menu", { name: `Actions for ${name}` });
}
function choose(name: string, item: string | RegExp) {
  fireEvent.click(within(openMenu(name)).getByRole("menuitem", { name: item }));
}
/** The last write the server received, once it has arrived. */
async function lastWrite(server: ReturnType<typeof navigationServer>) {
  await waitFor(() => expect(server.requests.length).toBeGreaterThan(0));
  return server.requests.at(-1);
}
const navigationWrite = (session: SessionSummary, change: unknown) => ({
  method: "PATCH",
  path: `/projects/${session.projectId}/navigation`,
  body: { revision: 0, change },
});

describe("every item in a session's context menu", () => {
  it("Pin and Unpin send the pin", async () => {
    const plain = row("Plain");
    const pinned = row("Already pinned", { pinned: true });
    const server = await mount([plain, pinned]);
    choose("Plain", "Pin");
    expect(await lastWrite(server)).toEqual(navigationWrite(plain, { kind: "pin", pinned: true }));
    choose("Already pinned", "Unpin");
    await waitFor(() =>
      expect(server.requests.at(-1)).toEqual(
        navigationWrite(pinned, { kind: "pin", pinned: false }),
      ),
    );
  });

  it("Settle and Un-settle send the settle", async () => {
    const open = row("Open work");
    const settled = row("Shipped", { doneAt: ago(1) });
    const server = await mount([open, settled]);
    choose("Open work", "Settle");
    expect(await lastWrite(server)).toEqual(navigationWrite(open, { kind: "done", value: true }));
    fireEvent.click(screen.getByRole("button", { name: /^Settled/ }));
    choose("Shipped", "Un-settle");
    await waitFor(() =>
      expect(server.requests.at(-1)).toEqual(
        navigationWrite(settled, { kind: "done", value: false }),
      ),
    );
  });

  it("each Snooze preset sends its own wake time, shown beside it", async () => {
    const presets = snoozePresets(new Date());
    const rows = presets.map((_, index) => row(`Snooze ${index}`));
    const server = await mount(rows);
    for (const [index, preset] of presets.entries()) {
      const menu = openMenu(`Snooze ${index}`);
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Snooze" }));
      const submenu = within(menu).getByRole("menu", { name: "Snooze" });
      fireEvent.click(
        within(submenu).getByRole("menuitem", { name: `${preset.label} ${preset.whenLabel}` }),
      );
      await waitFor(() => expect(server.requests).toHaveLength(index + 1));
      const body = server.requests[index]?.body as { change: { kind: string; until: string } };
      expect(body.change.kind).toBe("snooze");
      // A preset is computed again at the moment it is chosen; a minute's leeway covers that.
      expect(
        Math.abs(Date.parse(body.change.until) - Date.parse(preset.snoozedUntil)),
      ).toBeLessThan(60_000);
    }
  });

  it("Snooze → Custom… asks for a time and sends it", async () => {
    const session = row("Later");
    const server = await mount([session]);
    const menu = openMenu("Later");
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Snooze" }));
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Custom…" }));
    const dialog = screen.getByRole("dialog", { name: "Snooze until" });
    fireEvent.change(within(dialog).getByLabelText("Wake time"), {
      target: { value: "2099-01-02T09:30" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Snooze" }));
    expect(await lastWrite(server)).toEqual(
      navigationWrite(session, {
        kind: "snooze",
        until: new Date("2099-01-02T09:30").toISOString(),
      }),
    );
  });

  it("Wake sends the snooze back to nothing", async () => {
    const session = row("Sleeping", { snoozedUntil: ago(-60) });
    const server = await mount([session]);
    fireEvent.click(screen.getByRole("button", { name: /^Snoozed/ }));
    choose("Sleeping", "Wake");
    expect(await lastWrite(server)).toEqual(
      navigationWrite(session, { kind: "snooze", until: null }),
    );
  });

  it("Rename edits the title in place and sends the new name", async () => {
    const session = row("Old title");
    const server = await mount([session]);
    choose("Old title", "Rename");
    const field = screen.getByRole("textbox", { name: "Session name" });
    expect(field).toHaveFocus();
    fireEvent.change(field, { target: { value: "New title" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(await lastWrite(server)).toEqual({
      method: "PATCH",
      path: `/projects/${session.projectId}`,
      body: { name: "New title" },
    });
    expect(link("New title")).toHaveFocus();
  });

  it("Mark unread and Mark read send the read state", async () => {
    const read = row("Read one", { readAt: ago(1) });
    const unread = row("Unread one", {}, { activityAt: ago(30) });
    const server = await mount([read, unread]);
    choose("Read one", "Mark unread");
    expect(await lastWrite(server)).toEqual(
      navigationWrite(read, { kind: "read", at: read.activityAt, unread: true }),
    );
    choose("Unread one", "Mark read");
    await waitFor(() =>
      expect(server.requests.at(-1)).toEqual(
        navigationWrite(unread, { kind: "read", at: unread.activityAt, unread: false }),
      ),
    );
  });

  it("Filter by this source narrows the list to it and sends nothing; Show all undoes it", async () => {
    const mine = row("From the storefront");
    const scratch = row("A sketch", {}, { repository: null });
    const server = await mount([mine, scratch]);
    choose("From the storefront", "Filter by storefront");
    expect(screen.queryByRole("link", { name: /A sketch/ })).toBeNull();
    choose("From the storefront", "Show all sources");
    expect(link("A sketch")).toBeInTheDocument();
    expect(server.requests).toEqual([]);
  });

  it("Copy → Session link and Copy → Branch put them on the clipboard and send nothing", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const session = row("Copy me");
    const server = await mount([session]);
    for (const [item, expected] of [
      ["Session link", `${window.location.origin}/p/${session.projectId}`],
      ["Branch", "nap/fix-header"],
    ] as const) {
      const menu = openMenu("Copy me");
      fireEvent.click(within(menu).getByRole("menuitem", { name: "Copy" }));
      fireEvent.click(within(menu).getByRole("menuitem", { name: item }));
      await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(expected));
    }
    expect(await screen.findByText("Branch copied")).toHaveAttribute("role", "status");
    expect(server.requests).toEqual([]);
  });

  it("Put away workspace sends the close", async () => {
    const session = row("Running");
    const server = await mount([session]);
    choose("Running", "Put away workspace");
    expect(await lastWrite(server)).toEqual({
      method: "POST",
      path: `/projects/${session.projectId}/close`,
      body: null,
    });
  });

  it("Archive sends the archive, and the row leaves the sidebar at once", async () => {
    const session = row("Old news");
    const server = await mount([session]);
    choose("Old news", "Archive");
    expect(screen.queryByRole("link", { name: /Old news/ })).toBeNull();
    expect(await lastWrite(server)).toEqual(
      navigationWrite(session, { kind: "archive", value: true }),
    );
  });

  it("Delete asks first, and sends the delete only once it is confirmed", async () => {
    const session = row("Doomed");
    const server = await mount([session]);
    choose("Doomed", "Delete");
    const dialog = screen.getByRole("dialog", { name: "Delete session?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(server.requests).toEqual([]);
    choose("Doomed", "Delete");
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "Delete session?" })).getByRole("button", {
        name: "Delete",
      }),
    );
    expect(await lastWrite(server)).toEqual({
      method: "DELETE",
      path: `/projects/${session.projectId}`,
      body: null,
    });
  });
});

describe("the context menu by keyboard", () => {
  it.each([
    ["the Context Menu key", { key: "ContextMenu" }],
    ["Shift+F10", { key: "F10", shiftKey: true }],
  ])("opens from %s, moves by arrows, and gives focus back on Escape", async (_, keys) => {
    await mount([row("Keyboard reader")]);
    const target = link("Keyboard reader");
    target.focus();
    fireEvent.keyDown(target, keys);
    const menu = screen.getByRole("menu", { name: "Actions for Keyboard reader" });
    const items = within(menu).getAllByRole("menuitem");
    expect(items[0]).toHaveFocus();
    fireEvent.keyDown(items[0] as HTMLElement, { key: "ArrowDown" });
    expect(items[1]).toHaveFocus();
    fireEvent.keyDown(items[1] as HTMLElement, { key: "ArrowUp" });
    fireEvent.keyDown(items[0] as HTMLElement, { key: "End" });
    expect(items.at(-1)).toHaveFocus();
    fireEvent.keyDown(items.at(-1) as HTMLElement, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();
    expect(target).toHaveFocus();
  });

  it("opens a submenu with Right and closes it with Left", async () => {
    await mount([row("Nested")]);
    const target = link("Nested");
    target.focus();
    fireEvent.keyDown(target, { key: "ContextMenu" });
    const menu = screen.getByRole("menu", { name: "Actions for Nested" });
    const snooze = within(menu).getByRole("menuitem", { name: "Snooze" });
    snooze.focus();
    fireEvent.keyDown(snooze, { key: "ArrowRight" });
    expect(snooze).toHaveAttribute("aria-expanded", "true");
    const first = within(within(menu).getByRole("menu", { name: "Snooze" })).getAllByRole(
      "menuitem",
    )[0] as HTMLElement;
    expect(first).toHaveFocus();
    fireEvent.keyDown(first, { key: "ArrowLeft" });
    expect(snooze).toHaveFocus();
    expect(snooze).toHaveAttribute("aria-expanded", "false");
  });
});

describe("acting before the server answers", () => {
  it("moves a settled row at once and keeps it there through the reply", async () => {
    const session = row("Instant");
    const server = await mount([session]);
    const release = server.hold();
    choose("Instant", "Settle");
    // Drawn on the Settled shelf while the write is still held at the server.
    expect(screen.getByRole("button", { name: "Settled (1)" })).toBeInTheDocument();
    expect(
      within(screen.getByRole("list", { name: "Inbox sessions" })).queryByRole("link"),
    ).toBeNull();
    await act(async () => release());
    await waitFor(() => expect(server.rows()[0]?.navigation.doneAt).not.toBeNull());
    expect(screen.getByRole("button", { name: "Settled (1)" })).toBeInTheDocument();
    // And it can be taken back.
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
  });

  it("puts a refused action back and says why, by name", async () => {
    const session = row("Refused");
    const server = await mount([session]);
    server.refuseNext(409, "Wait for active work to finish before parking this session.");
    choose("Refused", "Settle");
    expect(
      await screen.findByText(
        "“Refused”: Wait for active work to finish before parking this session.",
      ),
    ).toHaveAttribute("role", "alert");
    expect(within(screen.getByRole("list", { name: "Inbox sessions" })).getByRole("link")).toBe(
      link("Refused"),
    );
  });
});

describe("Woke", () => {
  it("shows a snooze that ran out as Woke, unreceded, until it is dismissed", async () => {
    const session = row("Back again", { snoozedUntil: ago(5), readAt: ago(60) });
    const server = await mount([session]);
    expect(within(link("Back again")).getByRole("status")).toHaveTextContent("Woke");
    // The receded title is normal weight; a row worth looking at is not.
    expect(within(link("Back again")).getByText("Back again")).toHaveClass("font-medium");
    fireEvent.click(screen.getByRole("button", { name: "Dismiss Woke for Back again" }));
    expect(within(link("Back again")).queryByRole("status")).toBeNull();
    expect(await lastWrite(server)).toEqual(
      navigationWrite(session, {
        kind: "read",
        at: session.navigation.snoozedUntil,
        unread: false,
      }),
    );
  });
});

describe("selecting several", () => {
  it("adds with Ctrl-click, extends with Shift-click, and settles, archives or deletes them together", async () => {
    const rows = ["One", "Two", "Three", "Four"].map((name, index) =>
      row(name, { position: index }),
    );
    const server = await mount(rows);
    fireEvent.click(link("One"), { ctrlKey: true });
    fireEvent.click(link("Three"), { shiftKey: true });
    const bar = screen.getByRole("toolbar", { name: "Selected sessions" });
    expect(bar).toHaveTextContent("3 selected");
    expect(server.requests).toEqual([]);
    fireEvent.click(within(bar).getByRole("button", { name: "Settle" }));
    await waitFor(() => expect(server.requests).toHaveLength(3));
    expect(server.requests.map((request) => request.body)).toEqual(
      rows.slice(0, 3).map(() => ({ revision: 0, change: { kind: "done", value: true } })),
    );
    expect(screen.queryByRole("toolbar")).toBeNull();

    fireEvent.click(link("Four"), { ctrlKey: true });
    fireEvent.click(
      within(screen.getByRole("toolbar", { name: "Selected sessions" })).getByRole("button", {
        name: "Archive",
      }),
    );
    await waitFor(() => expect(server.requests).toHaveLength(4));
    expect(server.requests[3]?.body).toEqual({
      revision: 0,
      change: { kind: "archive", value: true },
    });
  });

  it("deletes a selection only after confirming the count", async () => {
    const rows = [row("Alpha"), row("Beta")];
    const server = await mount(rows);
    fireEvent.click(link("Alpha"), { ctrlKey: true });
    fireEvent.click(link("Beta"), { ctrlKey: true });
    fireEvent.click(
      within(screen.getByRole("toolbar", { name: "Selected sessions" })).getByRole("button", {
        name: "Delete",
      }),
    );
    const dialog = screen.getByRole("dialog", { name: "Delete 2 sessions?" });
    expect(server.requests).toEqual([]);
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete 2" }));
    await waitFor(() => expect(server.requests).toHaveLength(2));
    expect(server.requests.map((request) => request.method)).toEqual(["DELETE", "DELETE"]);
  });

  it("clears on Escape", async () => {
    await mount([row("Solo")]);
    fireEvent.click(link("Solo"), { ctrlKey: true });
    fireEvent.keyDown(link("Solo"), { key: "Escape" });
    expect(screen.queryByRole("toolbar")).toBeNull();
  });
});

describe("keyboard shortcuts", () => {
  it("jumps with Ctrl and a digit, and shows which digit while Ctrl is held", async () => {
    const opened = vi.fn();
    const rows = ["First", "Second"].map((name, index) => row(name, { position: index }));
    await mount(rows, opened);
    vi.useFakeTimers();
    try {
      fireEvent.keyDown(window, { key: "Control", ctrlKey: true });
      expect(screen.queryByText("Ctrl 2")).toBeNull();
      act(() => vi.advanceTimersByTime(250));
      expect(within(link("Second")).getByText("Ctrl 2")).toBeInTheDocument();
      fireEvent.keyDown(window, { key: "2", code: "Digit2", ctrlKey: true });
      expect(opened).toHaveBeenCalledExactlyOnceWith(rows[1]?.projectId);
      fireEvent.keyUp(window, { key: "Control" });
      expect(screen.queryByText("Ctrl 2")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("steps to the next and previous session with Ctrl+Shift+] and [", async () => {
    const opened = vi.fn();
    const rows = ["Top", "Middle"].map((name, index) => row(name, { position: index }));
    await mount(rows, opened);
    fireEvent.keyDown(window, { key: "}", code: "BracketRight", ctrlKey: true, shiftKey: true });
    expect(opened).toHaveBeenLastCalledWith(rows[0]?.projectId);
    fireEvent.keyDown(window, { key: "{", code: "BracketLeft", ctrlKey: true, shiftKey: true });
    expect(opened).toHaveBeenLastCalledWith(rows[1]?.projectId);
  });

  it("moves between rows with the arrows and opens one with Enter", async () => {
    const opened = vi.fn();
    const rows = ["Upper", "Lower"].map((name, index) => row(name, { position: index }));
    await mount(rows, opened);
    link("Upper").focus();
    fireEvent.keyDown(link("Upper"), { key: "ArrowDown" });
    expect(link("Lower")).toHaveFocus();
    // Enter on a link is a click with no pointer behind it — `detail` 0 — so it opens at once.
    fireEvent.click(link("Lower"), { detail: 0 });
    expect(opened).toHaveBeenCalledExactlyOnceWith(rows[1]?.projectId);
  });
});
