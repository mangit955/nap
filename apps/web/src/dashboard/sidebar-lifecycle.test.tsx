import {
  NavigationSchema,
  type SessionSummary,
  sessionSection,
} from "@nap/shared/session-navigation";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { IDBFactory } from "fake-indexeddb";
import { createElement } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { type ComposerDraft, ComposerDraftStore } from "../projects/composer-draft.ts";
import { ArchivedSessions } from "../settings/archived-sessions.tsx";
import { SessionList } from "./session-list.tsx";
import { shelveSessions } from "./session-rows.ts";
import { Sidebar } from "./sidebar.tsx";
import { SourceFilter } from "./source-filter.tsx";

const now = Date.parse("2026-10-23T12:00:00Z");
const at = (deltaMinutes: number) => new Date(now + deltaMinutes * 60000).toISOString();
function row(name: string, nav: Partial<SessionSummary["navigation"]> = {}): SessionSummary {
  return {
    projectId: crypto.randomUUID(),
    name,
    status: "ready",
    sandboxId: null,
    sessionIds: [],
    createdAt: at(-100),
    updatedAt: at(-100),
    navigation: NavigationSchema.parse(nav),
    revision: 0,
    activity: "ready",
    activityAt: null,
    requestedAt: null,
    repository: "example/app",
    branch: null,
    pullRequest: null,
    pendingFeedback: 0,
  };
}
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Network prohibited in review probe");
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

it("DATA-01: a persisted reorder changes settled and snoozed display order", () => {
  const early = row("Earlier", { snoozedUntil: at(60), position: 1 });
  const late = row("Later", { snoozedUntil: at(120), position: 0 });
  expect
    .soft(shelveSessions([early, late], now).snoozed.map((r) => r.name))
    .toEqual(["Later", "Earlier"]);
  const newest = row("Newest", { doneAt: at(-1), position: 1 });
  const oldest = row("Oldest", { doneAt: at(-20), position: 0 });
  expect
    .soft(shelveSessions([newest, oldest], now).settled.map((r) => r.name))
    .toEqual(["Oldest", "Newest"]);
});

it("DATA-02: a newer request removes an archived row from archive presentation", () => {
  const reopened = { ...row("Reopened", { archivedAt: at(-10) }), requestedAt: at(-1) };
  expect(sessionSection(reopened, now)).toBe("active");
  render(createElement(ArchivedSessions, { sessions: [reopened], onRestore: vi.fn() }));
  expect(screen.queryByRole("link", { name: "Reopened" })).toBeNull();
});

it("DATA-03: the selected settled row retains its inverse hover action outside a collapsed shelf", () => {
  const settled = row("Selected settled", { doneAt: at(-10) });
  const change = vi.fn();
  render(
    createElement(SessionList, {
      sessions: [settled],
      activeProjectId: settled.projectId,
      query: "",
      repository: "",
      onChange: change,
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Un-settle Selected settled" }));
  expect(change).toHaveBeenCalledWith(settled.projectId, { kind: "done", value: false });
});

it("DATA-Q1: background draft reads must not re-enable saves after clearOwner", async () => {
  vi.stubGlobal("indexedDB", new IDBFactory());
  const ownerId = crypto.randomUUID();
  const draft = (id: string, text: string): ComposerDraft => ({
    id,
    ownerId,
    operationId: id,
    text,
    source: null,
    attachments: [],
    expiresAt: Date.now() + 60000,
  });
  const a = draft("00000000-0000-4000-8000-000000000001", "Private A");
  const b = draft("00000000-0000-4000-8000-000000000002", "Private B");
  const store = new ComposerDraftStore();
  await store.save(a);
  await store.save(b);
  render(
    createElement(Sidebar, {
      ownerId,
      name: "Reader",
      email: undefined,
      recents: [],
      onNewProject: vi.fn(),
      onApiKey: vi.fn(),
      keyHint: undefined,
      onSignOut: vi.fn(),
    }),
  );
  await screen.findByRole("link", { name: /Private B/ });
  const load = vi.spyOn(ComposerDraftStore.prototype, "load");
  const originalRemove = ComposerDraftStore.prototype.remove;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached = () => {};
  const firstRemoval = new Promise<void>((resolve) => {
    reached = resolve;
  });
  vi.spyOn(ComposerDraftStore.prototype, "remove").mockImplementation(async function (
    this: ComposerDraftStore,
    owner,
    id,
  ) {
    await originalRemove.call(this, owner, id);
    if (id === a.id) {
      reached();
      await gate;
    }
  });
  const clearing = store.clearOwner(ownerId);
  try {
    await act(async () => {
      await firstRemoval;
    });
    // Removal of A has completed; pause clearOwner before it removes B.
    // The real marker event lets Sidebar and DraftRows read B in that gap.
    await waitFor(() => expect(load).toHaveBeenCalledWith(ownerId, b.id));
  } finally {
    release();
    await act(async () => {
      await clearing;
    });
  }
  // ChatInput has an unmount save with this contract. This isolates that late write from auth timing.
  await act(async () => {
    await store.save(a);
  });
  expect(await store.load(ownerId, a.id)).toBeNull();
});

it.each(["settled", "snoozed"] as const)(
  "retains %s Move down ordering after persisted rows reload",
  (shelf) => {
    localStorage.setItem(
      "nap.sidebar.shelves.local",
      JSON.stringify({ settled: true, snoozed: true }),
    );
    const first = row(
      "First",
      shelf === "settled"
        ? { doneAt: at(-1) }
        : { snoozedUntil: new Date(Date.now() + 60000).toISOString() },
    );
    const next = row(
      "Next",
      shelf === "settled"
        ? { doneAt: at(-10) }
        : { snoozedUntil: new Date(Date.now() + 120000).toISOString() },
    );
    const reorder = vi.fn();
    const props = {
      sessions: [first, next],
      query: "",
      repository: "",
      onChange: vi.fn(),
      onReorder: reorder,
    };
    const view = render(<SessionList {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Session actions for First" }));
    fireEvent.click(screen.getByRole("button", { name: "Move down" }));
    expect(reorder).toHaveBeenCalledExactlyOnceWith({
      section: shelf === "settled" ? "done" : "snoozed",
      rows: [
        { projectId: next.projectId, revision: 0 },
        { projectId: first.projectId, revision: 0 },
      ],
    });
    // The server's order mutation stores these positions; reload may return rows in any order.
    view.rerender(
      <SessionList
        {...props}
        sessions={[
          { ...first, revision: 1, navigation: { ...first.navigation, position: 1 } },
          { ...next, revision: 1, navigation: { ...next.navigation, position: 0 } },
        ]}
      />,
    );
    const list = screen.getByRole("list", {
      name: shelf === "settled" ? "Settled sessions" : "Snoozed sessions",
    });
    expect(
      within(list)
        .getAllByRole("link")
        .map((link) => link.getAttribute("href")),
    ).toEqual([`/p/${next.projectId}`, `/p/${first.projectId}`]);
  },
);

it.each(["ready", "queued", "working"] as const)(
  "uses canonical archive membership for %s sessions in Settings and sources",
  (activity) => {
    const reopened = {
      ...row("Reopened", { archivedAt: at(-10) }),
      repository: "example/reopened",
      activity,
      requestedAt: activity === "ready" ? at(-1) : at(-20),
    };
    const archived = {
      ...row("Archived", { archivedAt: at(-10) }),
      repository: "example/archived",
    };
    render(
      <>
        <ArchivedSessions sessions={[reopened, archived]} onRestore={vi.fn()} />
        <SourceFilter sessions={[reopened, archived]} value="" onChange={vi.fn()} />
      </>,
    );
    expect(screen.queryByRole("link", { name: "Reopened" })).toBeNull();
    expect(screen.getByRole("link", { name: "Archived" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Filter by source" }));
    expect(screen.getByRole("button", { name: "example/reopened" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "example/archived" })).toBeNull();
  },
);

it.each([
  ["settled", "collapsed"],
  ["settled", "query"],
  ["settled", "source"],
  ["settled", "paging"],
  ["snoozed", "collapsed"],
  ["snoozed", "query"],
  ["snoozed", "source"],
] as const)("keeps the %s inverse action in the %s fallback", (shelf, reason) => {
  localStorage.setItem(
    "nap.sidebar.shelves.local",
    JSON.stringify({ settled: reason !== "collapsed", snoozed: reason !== "collapsed" }),
  );
  const selected = row(
    "Selected",
    shelf === "settled"
      ? { doneAt: at(-10), position: 10 }
      : { snoozedUntil: new Date(Date.now() + 60000).toISOString() },
  );
  const sessions =
    reason === "paging"
      ? [
          selected,
          ...Array.from({ length: 10 }, (_, index) =>
            row(`Earlier ${index}`, { doneAt: at(-1), position: index }),
          ),
        ]
      : [selected];
  const change = vi.fn();
  render(
    <SessionList
      sessions={sessions}
      activeProjectId={selected.projectId}
      query={reason === "query" ? "unmatched" : ""}
      repository={reason === "source" ? "another/repo" : ""}
      onChange={change}
    />,
  );
  const current = screen.getByRole("list", { name: "Current session" });
  fireEvent.click(
    within(current).getByRole("button", {
      name: `${shelf === "settled" ? "Un-settle" : "Wake"} Selected`,
    }),
  );
  expect(change).toHaveBeenCalledExactlyOnceWith(
    selected.projectId,
    shelf === "settled" ? { kind: "done", value: false } : { kind: "snooze", until: null },
  );
});
