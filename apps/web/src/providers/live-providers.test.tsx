import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const useSession = vi.fn();
const replace = vi.fn();
const providers = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));
vi.mock("../auth/client.ts", () => ({ authClient: { useSession: () => useSession() } }));
vi.mock("./providers-page.tsx", () => ({
  ProvidersPage: () => {
    providers();
    return <p>Connected account</p>;
  },
}));
const { LiveProviders } = await import("./live-providers.tsx");

beforeEach(() => vi.clearAllMocks());
describe("Provider account gate", () => {
  it("does not request provider data before sign-in is known", () => {
    useSession.mockReturnValue({ data: undefined, isPending: true });
    render(<LiveProviders />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading providers");
    expect(providers).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });
  it("redirects a signed-out visitor without fetching providers", async () => {
    useSession.mockReturnValue({ data: null, isPending: false });
    render(<LiveProviders />);
    await waitFor(() => expect(replace).toHaveBeenCalledWith("/sign-in"));
    expect(providers).not.toHaveBeenCalled();
  });
  it("asks a guest to sign in before connecting subscriptions", () => {
    useSession.mockReturnValue({ data: { user: { isAnonymous: true } }, isPending: false });
    render(<LiveProviders />);
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/sign-in?upgrade=1",
    );
    expect(
      screen.getByRole("heading", { level: 1, name: "Use your Claude or ChatGPT subscription" }),
    ).toBeVisible();
    expect(screen.getByRole("link", { name: "Back to workspace" })).toHaveAttribute(
      "href",
      "/dashboard",
    );
    expect(screen.getByText(/guest projects stay behind with the guest session/i)).toBeVisible();
    expect(providers).not.toHaveBeenCalled();
  });
  it("loads providers for an authenticated permanent account", () => {
    useSession.mockReturnValue({ data: { user: { isAnonymous: false } }, isPending: false });
    render(<LiveProviders />);
    expect(screen.getByText("Connected account")).toBeVisible();
  });
});
