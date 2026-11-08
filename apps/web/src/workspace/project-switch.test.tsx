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

import { act, render, screen, waitFor, within } from "@testing-library/react";
import { useEffect } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ev, OTHER_SESSION_ID, SESSION_ID } from "../testing/events.ts";
import { sockets } from "../testing/fake-socket.ts";

const PROJECT_A = "3e0fbc41-6f5d-4a8e-ab9c-4d5e6f708192";
const PROJECT_B = "4e0fbc41-6f5d-4a8e-ab9c-4d5e6f708192";
const BETA_TURN = "8d2e3f40-5b6c-4d7e-9f0a-1b2c3d4e5f60";

let currentParams: { projectId?: string } = {};
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useParams: () => currentParams,
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
  [PROJECT_A]: { name: "Alpha board", sessionId: SESSION_ID, file: "src/AlphaOnly.tsx" },
  [PROJECT_B]: { name: "Beta notes", sessionId: OTHER_SESSION_ID, file: "src/BetaOnly.tsx" },
} as const;

let net: ReturnType<typeof sockets>;
/** Held until a test opens it: the answer to A's file listing. */
let lateFilesForA: ReturnType<typeof gate>;

const fetchJson = async (url: string, init?: RequestInit): Promise<Response> => {
  const id = Object.keys(PROJECTS).find((key) => url.includes(key)) as
    | keyof typeof PROJECTS
    | undefined;
  if (id === undefined) return json({ error: "not found" }, 404);
  const project = PROJECTS[id];
  if (init?.method === "POST") return json({ opened: true }, 202);
  if (url.includes("/files")) {
    if (id === PROJECT_A) await lateFilesForA.wait;
    return json({ files: [project.file], ready: true });
  }
  if (url.endsWith(`/projects/${id}`))
    return json({
      projectId: id,
      name: project.name,
      status: "ready",
      sandboxId: `sbx_${id.slice(0, 4)}`,
      updatedAt: "2026-08-09T12:30:00.000Z",
      sessionIds: [project.sessionId],
    });
  return json({ error: "not found" }, 404);
};

function workspace(projectId: string) {
  currentParams = { projectId };
  return (
    <WorkspaceFrame>
      <LiveWorkspace projectId={projectId} fetchJson={fetchJson} createSocket={net.createSocket} />
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
  expect(within(main).queryByText("Alpha board")).toBeNull();
  expect(within(main).queryByRole("button", { name: "Stop" })).toBeNull();
  expect(document.querySelector('iframe[src*="alpha"]')).toBeNull();
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  sidebarMounts = 0;
  net = sockets();
  net.countGlobalToo(vi.stubGlobal);
  lateFilesForA = gate();
});

describe("switching projects in place", () => {
  it("shows the next project with nothing left of the last one", async () => {
    const view = render(workspace(PROJECT_A));
    const alpha = await replayAlpha();
    expect(await screen.findByText("Alpha reply")).toBeVisible();
    expect(screen.getByRole("button", { name: "Stop" })).toBeVisible();

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

    // A's file listing, asked for before the switch, answers after it.
    await act(async () => {
      lateFilesForA.open();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expectNothingOfAlpha();
    expect(net.opened.filter((socket) => !socket.closed)).toEqual([beta]);
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
