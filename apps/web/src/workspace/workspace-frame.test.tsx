import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";

const replace = vi.fn();
const useSession = vi.fn();
let params: Record<string, string | string[]> = {};
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace }),
  useParams: () => params,
}));
vi.mock("../auth/client.ts", () => ({ authClient: { useSession: () => useSession() } }));
vi.mock("./session-sidebar.tsx", () => ({
  SessionSidebar: ({ projectId }: { projectId: string | undefined }) => (
    <nav aria-label="Sessions">{projectId ?? "none"}</nav>
  ),
}));

const { WorkspaceFrame } = await import("./workspace-frame.tsx");
const { forgetPrefetchedProject } = await import("../projects/project-prefetch.ts");
const { LiveWorkspace } = await import("./live-workspace.tsx");
const { sockets } = await import("../testing/fake-socket.ts");
const { PROJECT_ID, SESSION_ID } = await import("../testing/events.ts");

beforeEach(() => {
  vi.clearAllMocks();
  params = {};
  forgetPrefetchedProject();
});

it("sends a visitor with no session to sign in, and draws no workspace", () => {
  useSession.mockReturnValue({ data: null, isPending: false });

  render(
    <WorkspaceFrame>
      <p>Workspace</p>
    </WorkspaceFrame>,
  );

  expect(screen.getByRole("status")).toHaveTextContent("Loading session…");
  expect(screen.queryByText("Workspace")).toBeNull();
  expect(replace).toHaveBeenCalledWith("/sign-in");
});

it("waits for the session before moving anybody", () => {
  useSession.mockReturnValue({ data: null, isPending: true });

  render(
    <WorkspaceFrame>
      <p>Workspace</p>
    </WorkspaceFrame>,
  );

  expect(replace).not.toHaveBeenCalled();
});

it("marks the project the URL names as the open one in the sidebar", () => {
  useSession.mockReturnValue({ data: { user: { id: "owner" } }, isPending: false });
  params = { projectId: "abc" };

  render(
    <WorkspaceFrame>
      <p>Workspace</p>
    </WorkspaceFrame>,
  );

  expect(screen.getByRole("navigation", { name: "Sessions" })).toHaveTextContent("abc");
  expect(screen.getByText("Workspace")).toBeVisible();
});

it("asks for the project while the session is still being checked, and draws the workspace's shape", () => {
  // The two used to run one after the other: the session check, and only then the project. Each
  // is a round trip from the page's host to the API's, and nobody is helped by waiting for both.
  useSession.mockReturnValue({ data: null, isPending: true });
  params = { projectId: "abc" };
  const asked: string[] = [];

  render(
    <WorkspaceFrame
      fetchJson={async (url) => {
        asked.push(url);
        return new Response("{}", { status: 200 });
      }}
    >
      <p>Workspace</p>
    </WorkspaceFrame>,
  );

  expect(asked).toEqual([expect.stringMatching(/\/projects\/abc$/)]);
  expect(screen.getByRole("status", { name: "Loading session…" })).toBeInTheDocument();
});

it("asks for nothing early once the session is known: the workspace asks for itself", () => {
  useSession.mockReturnValue({ data: { user: { id: "owner" } }, isPending: false });
  params = { projectId: "abc" };
  const asked: string[] = [];

  render(
    <WorkspaceFrame
      fetchJson={async (url) => {
        asked.push(url);
        return new Response("{}", { status: 200 });
      }}
    >
      <p>Workspace</p>
    </WorkspaceFrame>,
  );

  expect(asked).toEqual([]);
});

it("opens the workspace on the answer it asked for early, without asking a second time", async () => {
  useSession.mockReturnValue({ data: null, isPending: true });
  params = { projectId: PROJECT_ID };
  const asked: string[] = [];
  const fetchJson = async (url: string) => {
    const path = new URL(url).pathname;
    asked.push(path);
    const body =
      path === `/projects/${PROJECT_ID}`
        ? {
            projectId: PROJECT_ID,
            name: "Todo app",
            status: "ready",
            sandboxId: "sbx_1",
            updatedAt: "2026-08-09T12:30:00.000Z",
            sessionIds: [SESSION_ID],
          }
        : {};
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const net = sockets();
  // A function, so the rerender below hands React a new element rather than one it can skip.
  const page = () => (
    <WorkspaceFrame fetchJson={fetchJson}>
      <LiveWorkspace projectId={PROJECT_ID} fetchJson={fetchJson} createSocket={net.createSocket} />
    </WorkspaceFrame>
  );

  const view = render(page());
  // The session is still being checked, and the project is already on its way.
  expect(asked).toEqual([`/projects/${PROJECT_ID}`]);

  useSession.mockReturnValue({ data: { user: { id: "owner" } }, isPending: false });
  view.rerender(page());

  expect(
    await screen.findByRole("button", { name: /Rename this project.*Todo app/ }),
  ).toBeVisible();
  await waitFor(() => expect(net.opened).toHaveLength(1));
  expect(asked.filter((path) => path === `/projects/${PROJECT_ID}`)).toHaveLength(1);
});
