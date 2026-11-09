import { render, screen } from "@testing-library/react";
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

beforeEach(() => {
  vi.clearAllMocks();
  params = {};
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
