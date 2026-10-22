import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useSession = vi.fn();
const replace = vi.fn();
const connections = vi.fn();
const overview = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
vi.mock("../auth/client.ts", () => ({ authClient: { useSession: () => useSession() } }));
vi.mock("./connections.tsx", () => ({
  GitHubConnections: () => {
    connections();
    return <p>Connected account</p>;
  },
}));
vi.mock("../settings/connections-overview.tsx", () => ({
  ConnectionsOverview: () => {
    overview();
    return <p>Every connection</p>;
  },
}));
const { LiveConnectionsOverview, LiveGitHubConnections } = await import("./live-connections.tsx");

beforeEach(() => vi.clearAllMocks());
describe("GitHub connection account gate", () => {
  it("does not request installation data before sign-in is known", () => {
    useSession.mockReturnValue({ data: undefined, isPending: true });
    render(<LiveGitHubConnections />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading connections");
    expect(connections).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });
  it("redirects a signed-out visitor without fetching installations", async () => {
    useSession.mockReturnValue({ data: null, isPending: false });
    render(<LiveGitHubConnections />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/sign-in"));
    expect(connections).not.toHaveBeenCalled();
  });
  it("asks a guest to sign in before connecting repositories", () => {
    useSession.mockReturnValue({ data: { user: { isAnonymous: true } }, isPending: false });
    render(<LiveGitHubConnections />);
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/sign-in?upgrade=1",
    );
    expect(connections).not.toHaveBeenCalled();
  });
  it("loads connections for an authenticated permanent account", () => {
    useSession.mockReturnValue({ data: { user: { isAnonymous: false } }, isPending: false });
    render(<LiveGitHubConnections />);
    expect(screen.getByText("Connected account")).toBeVisible();
  });
  it("gates the overview behind the same account check", async () => {
    useSession.mockReturnValue({ data: null, isPending: false });
    const signedOut = render(<LiveConnectionsOverview />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/sign-in"));
    expect(overview).not.toHaveBeenCalled();
    signedOut.unmount();

    useSession.mockReturnValue({ data: { user: { isAnonymous: false } }, isPending: false });
    render(<LiveConnectionsOverview />);
    expect(screen.getByText("Every connection")).toBeVisible();
  });
});
