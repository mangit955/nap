import {
  NavigationSchema,
  type SessionSummary,
  sessionSection,
} from "@nap/shared/session-navigation";
import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { navigationServer } from "../testing/navigation-server.ts";
import { useSessionNavigation } from "./use-session-navigation.ts";

const row = (name: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  projectId: crypto.randomUUID(),
  name,
  status: "ready",
  sandboxId: "sandbox",
  sessionIds: [],
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  navigation: NavigationSchema.parse({}),
  revision: 0,
  activity: "ready",
  activityAt: null,
  requestedAt: null,
  repository: "example/storefront",
  branch: null,
  pullRequest: null,
  pendingFeedback: 0,
  runStartedAt: null,
  turnFinishedAt: null,
  diff: null,
  model: null,
  titling: false,
  ...extra,
});

async function mount(rows: SessionSummary[]) {
  const server = navigationServer(rows);
  const view = renderHook(() => useSessionNavigation({ fetchJson: server.fetchJson }));
  await waitFor(() => expect(view.result.current.status).toBe("ready"));
  const find = (id: string) => view.result.current.projects.find((item) => item.projectId === id);
  return { server, result: view.result, find };
}

const writes = (server: ReturnType<typeof navigationServer>) =>
  server.requests.map((request) => `${request.method} ${request.path}`);

it("reads every page of the list", async () => {
  const first = row("Example");
  const second = row("Docs");
  const fetchJson = vi.fn(async (url: string) =>
    Response.json(
      url.includes("?after=")
        ? { sessions: [second], next: null }
        : { sessions: [first], next: first.projectId },
    ),
  );
  const { result } = renderHook(() => useSessionNavigation({ fetchJson }));
  await waitFor(() => expect(result.current.projects).toHaveLength(2));
});

it("draws a change before the server answers, keeps it when it does, and undoes it", async () => {
  const session = row("Fix header");
  const { server, result, find } = await mount([session]);
  const release = server.hold();
  let saved: Promise<boolean> | undefined;
  act(() => {
    saved = result.current.change(session.projectId, { kind: "pin", pinned: true });
  });
  // Drawn at once, while the write is still held at the server.
  expect(find(session.projectId)?.navigation.pinned).toBe(true);
  expect(server.rows()[0]?.navigation.pinned).toBe(false);
  // A poll that lands mid-flight carries the old row, and must not flicker it back.
  await act(async () => result.current.reload());
  expect(find(session.projectId)?.navigation.pinned).toBe(true);
  await act(async () => {
    release();
    await saved;
  });
  expect(server.requests[0]?.body).toEqual({ revision: 0, change: { kind: "pin", pinned: true } });
  expect(find(session.projectId)).toMatchObject({ revision: 1, navigation: { pinned: true } });
  expect(result.current.undoAction?.label).toBe("Pinned");
  await act(async () => result.current.undo());
  expect(result.current.undoAction).toBeUndefined();
  expect(server.rows()[0]?.navigation.pinned).toBe(false);
  expect(find(session.projectId)?.navigation.pinned).toBe(false);
});

it("puts a refused change back and says which session and why", async () => {
  const session = row("Fix header");
  const { server, result, find } = await mount([session]);
  server.refuseNext(409, "Wait for active work to finish before parking this session.");
  let ok: boolean | undefined;
  await act(async () => {
    ok = await result.current.change(session.projectId, { kind: "done", value: true });
  });
  expect(ok).toBe(false);
  const current = find(session.projectId);
  expect(current && sessionSection(current, Date.now())).toBe("active");
  expect(result.current.actionError).toBe(
    "“Fix header”: Wait for active work to finish before parking this session.",
  );
  expect(result.current.undoAction).toBeUndefined();
  // The next action clears the old complaint rather than leaving it under a success.
  await act(async () => {
    await result.current.change(session.projectId, { kind: "pin", pinned: true });
  });
  expect(result.current.actionError).toBeUndefined();
});

it("sends actions one at a time, so a second change on a row carries the first's revision", async () => {
  const session = row("Fix header");
  const { server, result, find } = await mount([session]);
  const release = server.hold();
  let both: Promise<unknown> | undefined;
  act(() => {
    both = Promise.all([
      result.current.change(session.projectId, { kind: "pin", pinned: true }),
      result.current.change(session.projectId, { kind: "done", value: true }),
    ]);
  });
  const drawn = find(session.projectId);
  expect(drawn && sessionSection(drawn, Date.now())).toBe("done");
  await act(async () => {
    release();
    await both;
  });
  expect(server.requests.map((request) => (request.body as { revision: number }).revision)).toEqual(
    [0, 1],
  );
  expect(result.current.actionError).toBeUndefined();
  expect(find(session.projectId)?.revision).toBe(2);
});

it("abandons the rest of a move once one of its steps is refused", async () => {
  const settled = row("Shipped", {
    navigation: NavigationSchema.parse({ doneAt: new Date().toISOString() }),
  });
  const { server, result, find } = await mount([settled]);
  server.refuseNext(409, "This session changed in another tab. Try again.");
  await act(async () => {
    await result.current.apply(
      [
        { kind: "change", projectId: settled.projectId, change: { kind: "done", value: false } },
        { kind: "change", projectId: settled.projectId, change: { kind: "pin", pinned: true } },
      ],
      { label: "Pinned" },
    );
  });
  expect(writes(server)).toEqual([`PATCH /projects/${settled.projectId}/navigation`]);
  const current = find(settled.projectId);
  expect(current && sessionSection(current, Date.now())).toBe("done");
});

it("reorders with the revisions the server holds once earlier writes have landed", async () => {
  const a = row("A");
  const b = row("B");
  const { server, result, find } = await mount([a, b]);
  await act(async () => {
    await result.current.apply(
      [
        { kind: "change", projectId: a.projectId, change: { kind: "pin", pinned: true } },
        { kind: "change", projectId: b.projectId, change: { kind: "pin", pinned: true } },
        { kind: "reorder", section: "pinned", projectIds: [b.projectId, a.projectId] },
      ],
      { label: "Moved" },
    );
  });
  expect(server.requests.at(-1)?.body).toEqual({
    section: "pinned",
    rows: [
      { projectId: b.projectId, revision: 1 },
      { projectId: a.projectId, revision: 1 },
    ],
  });
  expect(find(b.projectId)?.navigation.position).toBe(0);
  expect(find(a.projectId)).toMatchObject({ revision: 2, navigation: { position: 1 } });
});

it("renames, puts away and deletes at once, and puts a refused delete back", async () => {
  const a = row("Old name");
  const b = row("Keep me");
  const { server, result, find } = await mount([a, b]);
  const release = server.hold();
  let renamed: Promise<boolean> | undefined;
  act(() => {
    renamed = result.current.rename(a.projectId, "New name");
  });
  expect(find(a.projectId)?.name).toBe("New name");
  await act(async () => {
    release();
    await renamed;
  });
  expect(server.rows()[0]?.name).toBe("New name");
  await act(async () => {
    await result.current.close(a.projectId);
  });
  expect(find(a.projectId)?.sandboxId).toBeNull();
  server.refuseNext(503, "Could not delete the project.");
  let deleted: boolean | undefined;
  await act(async () => {
    deleted = await result.current.remove(b.projectId);
  });
  expect(deleted).toBe(false);
  expect(find(b.projectId)?.name).toBe("Keep me");
  expect(result.current.actionError).toBe("“Keep me”: Could not delete the project.");
  await act(async () => {
    deleted = await result.current.remove(b.projectId);
  });
  expect(deleted).toBe(true);
  expect(find(b.projectId)).toBeUndefined();
});

it("keeps quiet about a refused read, which nobody asked for", async () => {
  const session = row("Fix header", { activityAt: new Date(Date.now() - 1000).toISOString() });
  const { server, result } = await mount([session]);
  server.refuseNext(409, "This session changed in another tab. Try again.");
  await act(async () => {
    await result.current.change(
      session.projectId,
      {
        kind: "read",
        at: session.activityAt,
        unread: false,
      },
      { quiet: true },
    );
  });
  expect(result.current.actionError).toBeUndefined();
});

it("does not let an older Undo overwrite a later unread change", async () => {
  const session = row("Keep unread");
  const { server, result } = await mount([session]);
  await act(async () => {
    await result.current.change(session.projectId, { kind: "pin", pinned: true });
    await result.current.change(session.projectId, { kind: "read", at: null, unread: true });
  });
  await act(async () => result.current.undo());
  expect(server.rows()[0]?.navigation.unread).toBe(true);
  expect(server.requests.at(-1)?.body).toMatchObject({ revision: 1, change: { kind: "restore" } });
  expect(result.current.actionError).toBe(
    "“Keep unread”: This session changed in another tab. Try again.",
  );
});

it("captures Undo after a refused predecessor, so it cannot resurrect the refused pin", async () => {
  const session = row("Keep unpinned");
  const { server, result } = await mount([session]);
  const release = server.hold();
  server.refuseNext(409, "Pin refused.");
  let saved: Promise<unknown> | undefined;
  act(() => {
    saved = Promise.all([
      result.current.change(session.projectId, { kind: "pin", pinned: true }),
      result.current.change(session.projectId, { kind: "done", value: true }),
    ]);
  });
  await act(async () => {
    release();
    await saved;
  });
  expect(result.current.undoAction?.label).toBe("Settled");
  await act(async () => result.current.undo());
  expect(server.rows()[0]?.navigation).toMatchObject({ pinned: false, doneAt: null });
});

it("uses the accepted order revision when a refresh sees the commit before its response", async () => {
  const a = row("A");
  const b = row("B");
  const server = navigationServer([a, b]);
  let holdRead = false;
  let releaseRead = () => {};
  let releaseOrder = () => {};
  const readGate = new Promise<void>((resolve) => {
    releaseRead = resolve;
  });
  const orderGate = new Promise<void>((resolve) => {
    releaseOrder = resolve;
  });
  let committed = false;
  const fetchJson = async (url: string, init?: RequestInit) => {
    if (holdRead && !init?.method) {
      holdRead = false;
      await readGate;
    }
    const response = await server.fetchJson(url, init);
    if (url.endsWith("/sessions/order")) {
      committed = true;
      await orderGate;
    }
    return response;
  };
  const { result } = renderHook(() => useSessionNavigation({ fetchJson }));
  await waitFor(() => expect(result.current.status).toBe("ready"));
  holdRead = true;
  let refresh: Promise<void> | undefined;
  let ordered: Promise<boolean> | undefined;
  act(() => {
    refresh = result.current.reload();
    ordered = result.current.apply([
      { kind: "reorder", section: "active", projectIds: [b.projectId, a.projectId] },
    ]);
  });
  await waitFor(() => expect(committed).toBe(true));
  await act(async () => {
    releaseRead();
    await refresh;
  });
  let pinned: Promise<boolean> | undefined;
  act(() => {
    pinned = result.current.change(a.projectId, { kind: "pin", pinned: true });
  });
  await act(async () => {
    releaseOrder();
    await ordered;
    await pinned;
  });
  expect(server.requests.at(-1)?.body).toEqual({
    revision: 1,
    change: { kind: "pin", pinned: true },
  });
  expect(server.rows().find((item) => item.projectId === a.projectId)?.navigation.pinned).toBe(
    true,
  );
  expect(result.current.actionError).toBeUndefined();
});

it("dims a session while its title is regenerated, then reads the name the server wrote", async () => {
  let session = row("Build me a habit tracker");
  let answer: (response: Response) => void = () => {};
  const fetchJson = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST" && url.endsWith(`/projects/${session.projectId}/title`))
      return new Promise<Response>((resolve) => {
        answer = resolve;
      });
    return Response.json({ sessions: [session], next: null });
  });
  const { result } = renderHook(() => useSessionNavigation({ fetchJson }));
  await waitFor(() => expect(result.current.status).toBe("ready"));
  let done: Promise<void> | undefined;
  act(() => {
    done = result.current.regenerateTitle(session.projectId);
  });
  expect(result.current.projects[0]?.titling).toBe(true);

  session = { ...session, name: "Team Standup Streaks" };
  await act(async () => {
    answer(Response.json({ ...session }));
    await done;
  });
  expect(result.current.projects[0]).toMatchObject({
    name: "Team Standup Streaks",
    titling: false,
  });
  expect(result.current.actionError).toBeUndefined();
});

it("says why a regenerated title was not written, and stops dimming the row", async () => {
  const session = row("Habit Tracker");
  const fetchJson = vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === "POST"
      ? Response.json(
          { error: "The model's title did not fit. The name is unchanged; try again." },
          { status: 502 },
        )
      : Response.json({ sessions: [session], next: null }),
  );
  const { result } = renderHook(() => useSessionNavigation({ fetchJson }));
  await waitFor(() => expect(result.current.status).toBe("ready"));
  await act(async () => result.current.regenerateTitle(session.projectId));
  expect(result.current.actionError).toMatch(/name is unchanged/);
  expect(result.current.projects[0]).toMatchObject({ name: "Habit Tracker", titling: false });
});
