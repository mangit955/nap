import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the dashboard does before it knows who is looking at it.
 *
 * The session, the router and the project list are the three things this component talks to and
 * none of them can be reached from a test, so all three are mocked at the module boundary — the
 * way `live-sign-in.test.tsx` does it.
 */

const replace = vi.fn();
const useSession = vi.fn();
const useProjects = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace, refresh: vi.fn() }),
}));

vi.mock("../auth/client.ts", () => ({
  AFTER_SIGN_IN: "/dashboard",
  authClient: { useSession: () => useSession(), signOut: vi.fn() },
}));

vi.mock("../projects/use-projects.ts", () => ({
  useProjects: () => {
    useProjects();
    return {
      projects: [],
      status: "ready",
      actionError: undefined,
      create: vi.fn(),
      close: vi.fn(),
      remove: vi.fn(),
    };
  },
}));

vi.mock("../projects/use-start-project.ts", () => ({
  useStartProject: () => ({ busy: false, error: undefined, start: vi.fn() }),
}));

const { LiveDashboard } = await import("./live-dashboard.tsx");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the dashboard, before there is a session", () => {
  it("asks the server for nothing at all", () => {
    // The project list answers 401 to a caller it does not recognise, and a 401 sends the
    // browser to `/sign-in?expired=1` — which tells somebody who has never signed in that
    // their session ran out. The request has to not happen, not merely be ignored.
    useSession.mockReturnValue({ data: null, isPending: false });

    render(<LiveDashboard />);

    expect(useProjects).not.toHaveBeenCalled();
  });

  it("sends a visitor to sign in", () => {
    useSession.mockReturnValue({ data: null, isPending: false });

    render(<LiveDashboard />);

    expect(replace).toHaveBeenCalledWith("/sign-in");
  });

  it("waits for the session to resolve before moving anybody", () => {
    // A redirect fired while the session is still loading signs out everybody who arrives with
    // a perfectly good cookie.
    useSession.mockReturnValue({ data: undefined, isPending: true });

    render(<LiveDashboard />);

    expect(replace).not.toHaveBeenCalled();
    expect(useProjects).not.toHaveBeenCalled();
  });

  it("draws the page once there is somebody to draw it for", () => {
    useSession.mockReturnValue({
      data: { user: { name: "Manas Raghuwanshi", email: "manas@example.com" } },
      isPending: false,
    });

    render(<LiveDashboard />);

    expect(screen.getByRole("heading", { name: /Manas/ })).toBeInTheDocument();
    expect(useProjects).toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });
});
