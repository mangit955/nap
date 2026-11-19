/**
 * Switching from one project to another without a document load.
 *
 * The sidebar navigates client-side, so the page that showed project A is not thrown away by
 * the browser any more: whatever forgets A has to be ours. These tests drive the real frame and
 * the real shell — the workspace's state, its subscription and its fetches — through a switch
 * from A to B, and assert that B's view holds nothing of A's: no prompt, no reply, no file, no
 * preview, no turn still running, no socket still open, and nothing A asked for landing late.
 *
 * Next itself also remounts a page whose dynamic segment changed, but that is its rendering
 * detail, not a promise, and it differs under cache components. The reset is asserted here
 * against our own keying, which holds whatever the router does.
 */

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { handOffStartedPrompt } from "../chat/started-prompt.ts";
import { PREVIEW_TITLE } from "../components/preview-pane.tsx";
import { LISTING_DEBOUNCE_MS } from "../files/use-project-files.ts";
import { recallLog } from "../hooks/remembered-logs.ts";
import { LIVE_BATCH_MS } from "../hooks/use-event-stream.ts";
import { knownProject, rememberProjects } from "../projects/known-projects.ts";
import { ev, OTHER_SESSION_ID, SESSION_ID } from "../testing/events.ts";
import { sockets } from "../testing/fake-socket.ts";

const PROJECT_A = "3e0fbc41-6f5d-4a8e-ab9c-4d5e6f708192";
const PROJECT_B = "4e0fbc41-6f5d-4a8e-ab9c-4d5e6f708192";
const BETA_TURN = "8d2e3f40-5b6c-4d7e-9f0a-1b2c3d4e5f60";
const ALPHA_REQUEST = "9e3f4a51-6c7d-4e8f-8a1b-2c3d4e5f6a71";

/** The address bar, which is where the workspace reads its project. See `open-project.ts`. */
let currentPath = "/p";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => currentPath,
}));
vi.mock("../auth/client.ts", () => ({
  authClient: {
    useSession: () => ({ data: { user: { id: "owner", name: "Owner" } }, isPending: false }),
  },
}));
let sidebarMounts = 0;
vi.mock("./session-sidebar.tsx", () => ({
  SessionSidebar: ({ projectId }: { projectId: string | undefined }) => {
    useEffect(() => {
      sidebarMounts += 1;
    }, []);
    return <nav aria-label="Sessions">{projectId}</nav>;
  },
}));

const { WorkspaceFrame } = await import("./workspace-frame.tsx");
const { LiveWorkspace } = await import("./live-workspace.tsx");

/** A fetch the test lets through when it chooses, so "a late answer for A" is a thing it can do. */
function gate(): { wait: Promise<void>; open: () => void } {
  let open = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const PROJECTS = {
  [PROJECT_A]: {
    name: "Alpha board",
    sessionId: SESSION_ID,
    file: "src/AlphaOnly.tsx",
    contents: "export const alpha = 1;\n",
  },
  [PROJECT_B]: {
    name: "Beta notes",
    sessionId: OTHER_SESSION_ID,
    file: "src/BetaOnly.tsx",
    contents: "export const beta = 2;\n",
  },
} as const;
type Project = (typeof PROJECTS)[keyof typeof PROJECTS];

let net: ReturnType<typeof sockets>;
/** Held until a test opens it: every read for A asked while `holdAlpha` is set. */
let lateForA: ReturnType<typeof gate>;
let holdAlpha: boolean;
/**
 * Which of A's reads reached the server while held, and which had their answer handed back.
 * Without the first, opening the gate could release nothing and the test would still pass;
 * without the second, a held read that never resolved would look the same as one ignored.
 */
let heldForA: string[];
let answeredForA: string[];
/** The session of every listing asked for, in order. */
let listings: string[];
/** Every POST, in order: a started prompt must never add one. */
let posted: string[];
/** When set, every project record waits for it — the record still on its way. */
let recordHeld: Promise<void> | undefined;
/** Projects deleted elsewhere: their record is a 404. */
let gone: Set<string>;
/** Every read, as method and path, in the order it was asked. */
let reads: string[];

const MODELS = {
  // Two, because a picker with nothing to choose between is not drawn.
  models: [
    { id: "openai/gpt-5.6-luna", label: "Luna", free: false, available: true },
    { id: "anthropic/claude-opus-5", label: "Opus", free: false, available: true },
  ],
  fallback: "openai/gpt-5.6-luna",
  key: { configured: false },
};

/** Holds a read for A when the test asks for it, and records that it did. */
async function maybeHold(project: Project, what: string): Promise<void> {
  if (project.sessionId !== SESSION_ID || !holdAlpha) return;
  heldForA.push(what);
  await lateForA.wait;
  answeredForA.push(what);
}

// The project record is addressed by project, the files by session — the same split the API
// makes — so each is routed on the id its real endpoint carries.
const fetchJson = async (url: string, init?: RequestInit): Promise<Response> => {
  if (init?.method === "POST") {
    posted.push(url);
    return json({ opened: true }, 202);
  }
  const { pathname, searchParams } = new URL(url);
  reads.push(pathname);
  if (pathname === "/models") return json(MODELS);
  if (pathname === "/account/api-key") return json({ configured: false });

  const bySession = Object.values(PROJECTS).find((project) =>
    pathname.startsWith(`/sessions/${project.sessionId}/`),
  );
  if (bySession !== undefined && pathname.endsWith("/files")) {
    listings.push(bySession.sessionId);
    await maybeHold(bySession, "listing");
    return json({ ready: true, files: [bySession.file], truncated: false });
  }
  if (bySession !== undefined && pathname.endsWith("/file")) {
    const path = searchParams.get("path");
    if (path !== bySession.file) return json({ error: "not found" }, 404);
    await maybeHold(bySession, "file");
    return json({
      path,
      contents: bySession.contents,
      truncated: false,
      bytes: bySession.contents.length,
    });
  }

  if (pathname.endsWith("/github")) return json({ error: "not found" }, 404);
  const id = Object.keys(PROJECTS).find((key) => pathname === `/projects/${key}`) as
    | keyof typeof PROJECTS
    | undefined;
  if (id === undefined || gone.has(id)) return json({ error: "not found" }, 404);
  await recordHeld;
  return json(recordOf(id));
};

function workspace(projectId: string) {
  currentPath = `/p/${projectId}`;
  return (
    <WorkspaceFrame>
      <LiveWorkspace fetchJson={fetchJson} createSocket={net.createSocket} />
    </WorkspaceFrame>
  );
}

/** Project A mid-turn: asked for something, answered, a preview up, and still working. */
async function replayAlpha() {
  await waitFor(() => expect(net.opened).toHaveLength(1));
  const socket = net.latest;
  expect(socket.url).toContain(SESSION_ID);
  await act(async () => {
    socket.open();
    socket.deliver({ type: "event", event: ev("user.message", { text: "Alpha prompt" }, 1) });
    socket.deliver({ type: "event", event: ev("turn.started", { source: "user" }, 2) });
    socket.deliver({ type: "event", event: ev("agent.message", { text: "Alpha reply" }, 3) });
    socket.deliver({
      type: "event",
      event: ev("preview.ready", { url: "https://5173-alpha.e2b.app", port: 5173 }, 4),
    });
    socket.deliver({ type: "ready" });
  });
  return socket;
}

/** Everything that would mean A is still on screen while B is the open project. */
function expectNothingOfAlpha() {
  const main = screen.getByRole("main");
  expect(within(main).queryByText("Alpha prompt")).toBeNull();
  expect(within(main).queryByText("Alpha reply")).toBeNull();
  expect(within(main).queryByText(/AlphaOnly/)).toBeNull();
  expect(within(main).queryByRole("button", { name: /AlphaOnly\.tsx/ })).toBeNull();
  expect(within(main).queryByRole("region", { name: "src/AlphaOnly.tsx (read-only)" })).toBeNull();
  expect(within(main).queryByText("Alpha board")).toBeNull();
  expect(within(main).queryByRole("button", { name: "Stop" })).toBeNull();
  for (const frame of screen.queryAllByTitle(PREVIEW_TITLE)) {
    expect(frame).not.toHaveAttribute("src", expect.stringContaining("alpha"));
  }
  // Alt text also finds a stale snapshot hidden from the accessibility tree.
  for (const snapshot of screen.queryAllByAltText(/last snapshot/i)) {
    expect(snapshot).not.toHaveAttribute("src", expect.stringContaining(PROJECT_A));
  }
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  sidebarMounts = 0;
  net = sockets();
  net.countGlobalToo(vi.stubGlobal);
  lateForA = gate();
  holdAlpha = false;
  heldForA = [];
  answeredForA = [];
  listings = [];
  posted = [];
  recordHeld = undefined;
  gone = new Set();
  reads = [];
});

/** The record the API answers for a project, which the sidebar's list also carries. */
function recordOf(
  projectId: keyof typeof PROJECTS,
  sessionId: string = PROJECTS[projectId].sessionId,
) {
  return {
    projectId,
    name: PROJECTS[projectId].name,
    status: "ready" as const,
    sandboxId: `sbx_${projectId.slice(0, 4)}`,
    updatedAt: "2026-08-09T12:30:00.000Z",
    sessionIds: [sessionId],
  };
}

const renamed = (name: string) => ({
  name,
  source: "model" as const,
  model: "openai/gpt-5.6-luna",
  usage: { inputTokens: 1, outputTokens: 1 },
});

const readsOf = (path: string) => reads.filter((read) => read === path).length;

describe("switching projects in place", () => {
  it("shows the next project with nothing left of the last one", async () => {
    const view = render(workspace(PROJECT_A));
    const alpha = await replayAlpha();
    expect(await screen.findByText("Alpha reply")).toBeVisible();
    expect(screen.getByRole("button", { name: "Stop" })).toBeVisible();
    // A's preview is really up, so its absence after the switch is the switch's doing.
    expect(await screen.findByTitle(PREVIEW_TITLE)).toHaveAttribute(
      "src",
      expect.stringContaining("alpha"),
    );

    // A's files really loaded, so their absence after the switch is the switch's doing too.
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    expect(
      await within(screen.getByRole("region", { name: "Files" })).findByRole("button", {
        name: "AlphaOnly.tsx",
      }),
    ).toBeVisible();

    // Two reads for A left in the air: a refreshed listing, which a changed file asks for, and
    // the contents of the file just opened. Both are on the wire before the switch.
    holdAlpha = true;
    await act(async () => {
      alpha.deliver({
        type: "event",
        event: ev(
          "file.changed",
          { path: "src/AlphaOnly.tsx", changeType: "modified", diff: "+alpha\n" },
          5,
        ),
      });
    });
    // Named "AlphaOnly.tsx changed" now, for anybody listening, hence the prefix match.
    fireEvent.click(
      within(screen.getByRole("region", { name: "Files" })).getByRole("button", {
        name: /^AlphaOnly\.tsx/,
      }),
    );
    await waitFor(() => expect([...heldForA].sort()).toEqual(["file", "listing"]));
    expect(
      within(screen.getByRole("region", { name: "src/AlphaOnly.tsx (read-only)" })).getByRole(
        "status",
      ),
    ).toHaveTextContent("Loading file…");

    view.rerender(workspace(PROJECT_B));

    // Before B has answered anything: the frame is B's and nothing of A's is in it.
    expectNothingOfAlpha();
    expect(alpha.closed).toBe(true);

    await waitFor(() => expect(net.opened).toHaveLength(2));
    const beta = net.latest;
    expect(beta.url).toContain(OTHER_SESSION_ID);
    await act(async () => {
      beta.open();
      // A finished turn, so a running one on screen could only be A's.
      const scope = { sessionId: OTHER_SESSION_ID, turnId: BETA_TURN };
      beta.deliver({ type: "event", event: ev("user.message", { text: "Beta prompt" }, 1, scope) });
      beta.deliver({ type: "event", event: ev("turn.started", { source: "user" }, 2, scope) });
      beta.deliver({
        type: "event",
        event: ev(
          "turn.completed",
          { usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 10, commitSha: null },
          3,
          scope,
        ),
      });
      beta.deliver({ type: "ready" });
    });
    expect(await screen.findByText("Beta prompt")).toBeVisible();

    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    const betaFiles = () => within(screen.getByRole("region", { name: "Files" }));
    expect(await betaFiles().findByRole("button", { name: "BetaOnly.tsx" })).toBeVisible();
    expectNothingOfAlpha();

    // A's listing and A's file, asked for before the switch, answer after it.
    await act(async () => {
      lateForA.open();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect([...answeredForA].sort()).toEqual(["file", "listing"]);

    expect(betaFiles().getByRole("button", { name: "BetaOnly.tsx" })).toBeVisible();
    expectNothingOfAlpha();
    expect(net.opened.filter((socket) => !socket.closed)).toEqual([beta]);
  });

  it("shows the next project's last picture while it opens, and never the last one's", async () => {
    const snapshot = () => screen.queryByRole("img", { name: /last snapshot/i });
    const pictureOf = (projectId: string) =>
      expect.stringContaining(`/projects/${projectId}/thumbnail`);
    const view = render(workspace(PROJECT_A));
    await replayAlpha();
    // A's picture is really on screen — jsdom never loads A's frame, so the start-up screen stays
    // over it — which makes its absence after the switch the switch's doing.
    await waitFor(() => expect(snapshot()).toHaveAttribute("src", pictureOf(PROJECT_A)));

    const recordForB = gate();
    recordHeld = recordForB.wait;
    view.rerender(workspace(PROJECT_B));

    // B's record is still on its way: no picture at all, rather than the one that is to hand.
    expect(snapshot()).toBeNull();
    expectNothingOfAlpha();

    await act(async () => {
      recordForB.open();
    });
    await waitFor(() => expect(snapshot()).toHaveAttribute("src", pictureOf(PROJECT_B)));
    expectNothingOfAlpha();
  });

  it("leaves nothing of the last project waiting to land: no buffered frame, no timer, no listing", async () => {
    // What batching added is state that waits: a replay held until `ready`, live frames held for
    // a frame, a listing held for its debounce. Every one of them belongs to A's mount, and a
    // switch in the middle of all three must take them with it.
    const view = render(workspace(PROJECT_A));
    const alpha = await replayAlpha();
    expect(
      await within(screen.getByRole("region", { name: "Conversation" })).findByText("Alpha reply"),
    ).toBeVisible();
    await waitFor(() => expect(listings).toEqual([SESSION_ID]));

    await act(async () => {
      alpha.deliver({
        type: "event",
        event: ev("agent.message", { text: "Alpha late reply" }, 5),
      });
      alpha.deliver({
        type: "event",
        event: ev(
          "file.changed",
          { path: "src/AlphaOnly.tsx", changeType: "modified", diff: "" },
          6,
        ),
      });
    });
    view.rerender(workspace(PROJECT_B));
    await waitFor(() => expect(net.opened).toHaveLength(2));
    const beta = net.latest;
    await act(async () => {
      beta.open();
      // Half a replay, then a frame for the wrong session: neither may be drawn yet, or ever.
      const scope = { sessionId: OTHER_SESSION_ID, turnId: BETA_TURN };
      beta.deliver({ type: "event", event: ev("user.message", { text: "Beta prompt" }, 1, scope) });
      alpha.deliver({ type: "event", event: ev("agent.message", { text: "Alpha after" }, 7) });
    });
    expect(within(screen.getByRole("main")).queryByText("Beta prompt")).toBeNull();
    await act(async () => {
      // Finished, so a running turn on screen could only be A's.
      const scope = { sessionId: OTHER_SESSION_ID, turnId: BETA_TURN };
      beta.deliver({ type: "event", event: ev("turn.started", { source: "user" }, 2, scope) });
      beta.deliver({
        type: "event",
        event: ev(
          "turn.completed",
          { usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 10, commitSha: null },
          3,
          scope,
        ),
      });
      beta.deliver({ type: "ready" });
    });
    expect(
      await within(screen.getByRole("region", { name: "Conversation" })).findByText("Beta prompt"),
    ).toBeVisible();

    // Past every batch and every debounce A had scheduled.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, LISTING_DEBOUNCE_MS + LIVE_BATCH_MS * 4));
    });
    expect(within(screen.getByRole("main")).queryByText("Alpha late reply")).toBeNull();
    expect(within(screen.getByRole("main")).queryByText("Alpha after")).toBeNull();
    expectNothingOfAlpha();
    expect(listings).toEqual([SESSION_ID, OTHER_SESSION_ID]);
  });

  it("shows a started prompt before A's record or log, and none of it in B", async () => {
    // The dashboard admitted this prompt as A's first request and opened A. Nothing of it is in
    // the workspace until the log is replayed, so the dashboard hands it over to draw meanwhile.
    handOffStartedPrompt({
      projectId: PROJECT_A,
      sessionId: SESSION_ID,
      requestId: ALPHA_REQUEST,
      text: "Alpha started",
    });
    const record = gate();
    recordHeld = record.wait;
    const conversation = () => within(screen.getByRole("region", { name: "Conversation" }));

    const view = render(workspace(PROJECT_A));
    expect(await conversation().findByText("Alpha started")).toBeVisible();
    expect(net.opened).toHaveLength(0);

    // The record answers and the log is subscribed to, but its replay has not finished.
    await act(async () => {
      record.open();
    });
    await waitFor(() => expect(net.opened).toHaveLength(1));
    const alpha = net.latest;
    await act(async () => {
      alpha.open();
      alpha.deliver({
        type: "event",
        event: ev("user.message", { text: "Alpha started" }, 1, { turnId: ALPHA_REQUEST }),
      });
    });
    expect(conversation().getAllByText("Alpha started")).toHaveLength(1);

    // The replay ends with the request's own prompt in it: still one.
    await act(async () => {
      alpha.deliver({ type: "ready" });
    });
    expect(conversation().getAllByText("Alpha started")).toHaveLength(1);
    expect(posted.filter((url) => url.includes("/turns"))).toEqual([]);

    view.rerender(workspace(PROJECT_B));
    expect(within(screen.getByRole("main")).queryByText("Alpha started")).toBeNull();
    await waitFor(() => expect(net.opened).toHaveLength(2));
    await act(async () => {
      net.latest.open();
      net.latest.deliver({ type: "ready" });
    });
    expect(within(screen.getByRole("main")).queryByText("Alpha started")).toBeNull();
    expect(posted.filter((url) => url.includes("/turns"))).toEqual([]);
  });

  it("draws a project seen earlier at once on coming back, and asks only for what came after", async () => {
    const view = render(workspace(PROJECT_A));
    await replayAlpha();
    expect(await screen.findByText("Alpha reply")).toBeVisible();

    view.rerender(workspace(PROJECT_B));
    await waitFor(() => expect(net.opened).toHaveLength(2));
    await act(async () => {
      net.latest.open();
      net.latest.deliver({ type: "ready" });
    });

    // A's record is held, so nothing from the server can be what draws A below.
    const record = gate();
    recordHeld = record.wait;
    const announced = vi.spyOn(BroadcastChannel.prototype, "postMessage");
    view.rerender(workspace(PROJECT_A));

    const conversation = within(screen.getByRole("region", { name: "Conversation" }));
    expect(conversation.getByText("Alpha prompt")).toBeVisible();
    expect(conversation.getByText("Alpha reply")).toBeVisible();
    expect(screen.queryByRole("status", { name: "Loading this conversation" })).toBeNull();
    expect(net.opened).toHaveLength(2);

    await act(async () => {
      record.open();
    });
    await waitFor(() => expect(net.opened).toHaveLength(3));
    const again = net.latest;
    expect(new URL(again.url).searchParams.get("seq")).toBe("4");
    await act(async () => {
      again.open();
      // What happened while B was open, replayed after A's last seq: history, not news.
      again.deliver({ type: "event", event: ev("agent.message", { text: " meanwhile" }, 5) });
      again.deliver({
        type: "event",
        event: ev(
          "turn.completed",
          { usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 10, commitSha: null },
          6,
        ),
      });
      again.deliver({ type: "ready" });
    });
    const now = () => within(screen.getByRole("region", { name: "Conversation" }));
    // The reply's chunks join into one passage: drawn once, with what came after it on the end.
    expect(await now().findByText("Alpha reply meanwhile")).toBeVisible();
    expect(now().getAllByText("Alpha prompt")).toHaveLength(1);
    const changes = () => announced.mock.calls.filter(([message]) => message === "changed").length;
    expect(changes()).toBe(0);

    // A turn that starts now is news, which shows the count above could have moved.
    await act(async () => {
      again.deliver({ type: "event", event: ev("turn.started", { source: "user" }, 7) });
    });
    await waitFor(() => expect(changes()).toBe(1));
    announced.mockRestore();
  });

  it("draws nothing kept for a project deleted elsewhere, and forgets it", async () => {
    const view = render(workspace(PROJECT_A));
    await replayAlpha();
    expect(await screen.findByText("Alpha reply")).toBeVisible();
    view.rerender(workspace(PROJECT_B));
    await waitFor(() => expect(net.opened).toHaveLength(2));

    gone.add(PROJECT_A);
    view.rerender(workspace(PROJECT_A));

    // No session ever arrives for a project that is gone, so a kept transcript drawn now would
    // stay on screen under the sentence saying it does not exist.
    expect(await screen.findByText("this project no longer exists")).toBeVisible();
    expect(within(screen.getByRole("main")).queryByText("Alpha reply")).toBeNull();
    expect(recallLog({ ownerId: "owner", projectId: PROJECT_A })).toBeUndefined();
    expect(net.opened).toHaveLength(2);
  });

  it("keeps the sidebar mounted across the switch", async () => {
    const view = render(workspace(PROJECT_A));
    expect(await screen.findByRole("navigation", { name: "Sessions" })).toHaveTextContent(
      PROJECT_A,
    );

    view.rerender(workspace(PROJECT_B));

    expect(screen.getByRole("navigation", { name: "Sessions" })).toHaveTextContent(PROJECT_B);
    expect(sidebarMounts).toBe(1);
  });
});

describe("what a switch asks the server for", () => {
  it("asks for the account's models and key once per tab, not once per project", async () => {
    const view = render(workspace(PROJECT_A));
    await replayAlpha();
    expect(await screen.findByRole("button", { name: "Model" })).toBeVisible();

    view.rerender(workspace(PROJECT_B));
    // Drawn from what the tab already holds: the picker is there before anything answers.
    expect(screen.getByRole("button", { name: "Model" })).toBeVisible();
    await waitFor(() => expect(net.opened).toHaveLength(2));
    await act(async () => {
      net.latest.open();
      net.latest.deliver({ type: "ready" });
    });
    view.rerender(workspace(PROJECT_A));
    await waitFor(() => expect(net.opened).toHaveLength(3));

    expect(readsOf("/models")).toBe(1);
    expect(readsOf("/account/api-key")).toBe(1);
  });

  it("connects to a project the tab already knows without waiting for its record", async () => {
    rememberProjects([recordOf(PROJECT_B)]);
    const view = render(workspace(PROJECT_A));
    await replayAlpha();

    const record = gate();
    recordHeld = record.wait;
    view.rerender(workspace(PROJECT_B));

    // B's record is still on its way, and B's socket is already asked for — the stream ticket in
    // production goes out in the same step — and its title already drawn.
    await waitFor(() => expect(net.opened).toHaveLength(2));
    expect(net.latest.url).toContain(OTHER_SESSION_ID);
    expect(within(screen.getByRole("main")).getByText("Beta notes")).toBeVisible();
    // Nothing that depends on the project's state is drawn from the list's copy of it.
    expect(screen.queryByRole("button", { name: /Rename this project/ })).toBeNull();
    expect(readsOf(`/projects/${PROJECT_B}`)).toBe(1);
    // GitHub state is read by project, so it goes out beside the record rather than after it.
    await waitFor(() => expect(readsOf(`/projects/${PROJECT_B}/github`)).toBe(1));

    await act(async () => {
      record.open();
    });
    expect(
      await screen.findByRole("button", { name: /Rename this project.*Beta notes/ }),
    ).toBeVisible();
    // The record named the same session, so the connection made early is the one kept.
    expect(net.opened).toHaveLength(2);
    expect(net.latest.closed).toBe(false);
  });

  it("moves to the record's session when the tab's copy named an older one", async () => {
    rememberProjects([recordOf(PROJECT_B, SESSION_ID)]);
    const record = gate();
    recordHeld = record.wait;
    render(workspace(PROJECT_B));
    await waitFor(() => expect(net.opened).toHaveLength(1));
    const early = net.latest;
    expect(early.url).toContain(SESSION_ID);

    await act(async () => {
      record.open();
    });
    await waitFor(() => expect(net.opened).toHaveLength(2));
    expect(early.closed).toBe(true);
    expect(net.latest.url).toContain(OTHER_SESSION_ID);
  });

  it("lets go of the tab's copy once the server says the project is gone", async () => {
    // Deleted in another tab after this tab's list was read: the list's copy names a session, so
    // a connection opens before the record answers — and must close once it says 404.
    rememberProjects([recordOf(PROJECT_A)]);
    gone.add(PROJECT_A);
    render(workspace(PROJECT_A));

    expect(await screen.findByText("this project no longer exists")).toBeVisible();
    expect(within(screen.getByRole("main")).queryByText("Alpha board")).toBeNull();
    await waitFor(() => expect(net.opened.every((socket) => socket.closed)).toBe(true));
    // Nor offered to the next open.
    expect(knownProject(PROJECT_A)).toBeUndefined();
  });

  it("reads the record again for a notice stored between its read and the replay", async () => {
    // The record goes out at the click and the socket subscribes a round trip later, so a notice
    // stored in between is in the replay and not in the record. Seconds old, it is read again.
    render(workspace(PROJECT_A));
    await waitFor(() => expect(net.opened).toHaveLength(1));
    await waitFor(() => expect(readsOf(`/projects/${PROJECT_A}`)).toBe(1));
    await act(async () => {
      net.latest.open();
      net.latest.deliver({
        type: "event",
        event: ev("project.renamed", renamed("Alpha renamed"), 1, {
          createdAt: new Date().toISOString(),
        }),
      });
      net.latest.deliver({ type: "ready" });
    });
    await waitFor(() => expect(readsOf(`/projects/${PROJECT_A}`)).toBe(2));
  });

  it("reads nothing twice when the replay carries notices the first reads already reflect", async () => {
    render(workspace(PROJECT_A));
    await waitFor(() => expect(net.opened).toHaveLength(1));
    await act(async () => {
      net.latest.open();
      net.latest.deliver({ type: "event", event: ev("user.message", { text: "Alpha prompt" }, 1) });
      net.latest.deliver({
        type: "event",
        event: ev("project.renamed", renamed("Alpha board"), 2),
      });
      net.latest.deliver({
        type: "event",
        event: ev(
          "turn.completed",
          { usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 10, commitSha: null },
          3,
        ),
      });
      net.latest.deliver({ type: "ready" });
    });
    expect(await screen.findByText("Alpha prompt")).toBeVisible();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, LISTING_DEBOUNCE_MS + 50));
    });
    expect(readsOf(`/projects/${PROJECT_A}`)).toBe(1);
    expect(readsOf(`/projects/${PROJECT_A}/github`)).toBe(1);
    expect(readsOf(`/sessions/${SESSION_ID}/files`)).toBe(1);

    // A notice that arrives after the replay is news, and the record is read again for it.
    await act(async () => {
      net.latest.deliver({
        type: "event",
        event: ev("project.renamed", renamed("Alpha renamed"), 4),
      });
    });
    await waitFor(() => expect(readsOf(`/projects/${PROJECT_A}`)).toBe(2));
  });
});
