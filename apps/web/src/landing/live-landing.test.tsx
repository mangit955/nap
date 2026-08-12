import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What the front page does with somebody who is already signed in: sends them to the dashboard.
 *
 * The session and the router are the two things this component talks to and neither can be
 * reached from a test, so both are mocked at the module boundary — the way `live-sign-in.test.tsx`
 * does it.
 */

const replace = vi.fn();
const useSession = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace, refresh: vi.fn() }),
}));

vi.mock("../auth/client.ts", () => ({
  AFTER_SIGN_IN: "/dashboard",
  authClient: { useSession: () => useSession(), signOut: vi.fn() },
}));

// The hero creates projects and the list loads them; neither has a server to talk to here.
vi.mock("../projects/use-start-project.ts", () => ({
  useStartProject: () => ({ busy: false, error: undefined, start: vi.fn() }),
}));

const { LiveLanding } = await import("./live-landing.tsx");

beforeEach(() => {
  vi.clearAllMocks();
});

describe("the front page, for somebody who is already signed in", () => {
  it("sends them to the dashboard rather than showing them the pitch", () => {
    useSession.mockReturnValue({ data: { user: { name: "Ada" } }, isPending: false });

    render(<LiveLanding />);

    expect(replace).toHaveBeenCalledWith("/dashboard");
  });

  it("offers nobody a way in until it knows whether they need one", () => {
    // A Sign in link drawn while the session is still resolving lands under the cursor of
    // somebody who is signed in and about to be moved to their dashboard.
    useSession.mockReturnValue({ data: undefined, isPending: true });

    render(<LiveLanding />);

    expect(replace).not.toHaveBeenCalled();
    // The bar, not the hero: the hero's two ways in are the page itself and are always there.
    expect(
      within(screen.getByRole("banner")).queryByRole("link", { name: /sign in/i }),
    ).not.toBeInTheDocument();
  });

  it("shows a visitor the way in, and does not move them", () => {
    useSession.mockReturnValue({ data: null, isPending: false });

    render(<LiveLanding />);

    expect(replace).not.toHaveBeenCalled();
    expect(
      within(screen.getByRole("banner")).getByRole("link", { name: /sign in/i }),
    ).toBeInTheDocument();
  });
});
