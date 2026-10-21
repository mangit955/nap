import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { GitHubConnections } from "./connections.tsx";

// jsdom parses `<dialog>` and implements none of its methods.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

const installation = {
  installationId: 42,
  userId: "a70e2120-867c-4eb7-bdd6-cdd1c33bac1e",
  githubUserId: 9,
  githubLogin: "owner",
  accountLogin: "nap-team",
  accountType: "Organization",
  status: "active",
};
const repositories = [
  { id: 102, fullName: "nap-team/site", defaultBranch: "main", private: true },
  { id: 101, fullName: "nap-team/docs", defaultBranch: "main", private: false },
];

describe("GitHub connections", () => {
  it("shows a configuration requirement without an unusable connect button", async () => {
    render(
      <GitHubConnections
        fetchJson={async () => Response.json({ configured: false, installations: [] })}
      />,
    );
    expect(await screen.findByText(/not configured for this nap deployment/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Add connection" })).toBeNull();
  });

  it("reports a network failure and allows a fresh connection load", async () => {
    let available = false;
    const fetchJson = async () => {
      if (!available) throw new Error("network");
      return Response.json({ configured: true, installations: [] });
    };
    render(<GitHubConnections fetchJson={fetchJson} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not reach the server");
    available = true;
    fireEvent.click(screen.getByRole("button", { name: "Refresh connections" }));
    await screen.findByText("No GitHub connections yet.");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("starts connection authorization on the server before leaving nap", async () => {
    const navigate = vi.fn();
    const fetchJson = vi.fn(async (url: string, _init?: RequestInit) =>
      url.endsWith("/connect")
        ? Response.json({ url: "https://github.com/login/oauth/authorize?state=opaque" })
        : Response.json({ configured: true, installations: [] }),
    );
    render(<GitHubConnections fetchJson={fetchJson} navigate={navigate} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add connection" }));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith(
        "https://github.com/login/oauth/authorize?state=opaque",
      ),
    );
    expect(fetchJson.mock.calls.find(([url]) => url.endsWith("/connect"))?.[1]).toMatchObject({
      method: "POST",
      body: "{}",
    });
  });

  it("lists a connection's repositories in its drawer, searchable and marked when public", async () => {
    const fetchJson = vi.fn(async (url: string) =>
      url.endsWith("/installations/42/repositories")
        ? Response.json({ repositories })
        : Response.json({ configured: true, installations: [installation] }),
    );
    render(<GitHubConnections fetchJson={fetchJson} />);
    fireEvent.click(await screen.findByRole("button", { name: /@nap-team/ }));
    const drawer = screen.getByRole("dialog", { name: "@nap-team" });
    expect(
      within(drawer).getByRole("link", { name: /Manage access for nap-team/ }),
    ).toHaveAttribute(
      "href",
      "https://github.com/organizations/nap-team/settings/installations/42",
    );
    // Nothing is asked of GitHub until the tab is opened.
    expect(fetchJson).toHaveBeenCalledTimes(1);

    fireEvent.click(within(drawer).getByRole("tab", { name: "Repositories" }));
    const list = await within(drawer).findByRole("list", { name: "Repositories" });
    expect(
      within(list)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["nap-team/docsPublic", "nap-team/site"]);
    fireEvent.change(within(drawer).getByLabelText("Search repositories"), {
      target: { value: "SITE" },
    });
    expect(
      within(list)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["nap-team/site"]);
    expect(within(drawer).getByText(/Last fetched: just now/)).toBeVisible();

    fireEvent.click(within(drawer).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("offers a suspended connection reconnection instead of its repositories", async () => {
    const navigate = vi.fn();
    const fetchJson = vi.fn(async (url: string, _init?: RequestInit) =>
      url.endsWith("/connect")
        ? Response.json({ url: "https://github.com/login/oauth/authorize?state=again" })
        : Response.json({
            configured: true,
            installations: [{ ...installation, status: "suspended" }],
          }),
    );
    render(<GitHubConnections fetchJson={fetchJson} navigate={navigate} />);
    expect(await screen.findByText("Suspended")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /@nap-team/ }));
    const drawer = screen.getByRole("dialog", { name: "@nap-team" });
    fireEvent.click(within(drawer).getByRole("tab", { name: "Repositories" }));
    expect(within(drawer).getByText(/Reconnect this connection to see/)).toBeVisible();
    expect(fetchJson.mock.calls.some(([url]) => url.endsWith("/repositories"))).toBe(false);

    fireEvent.click(within(drawer).getByRole("tab", { name: "General" }));
    fireEvent.click(within(drawer).getByRole("button", { name: "Reconnect" }));
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith("https://github.com/login/oauth/authorize?state=again"),
    );
    expect(fetchJson.mock.calls.find(([url]) => url.endsWith("/connect"))?.[1]?.body).toBe(
      JSON.stringify({ installationId: 42 }),
    );
  });

  it("keeps connection failure actionable and reloads after disconnect", async () => {
    let connected = true;
    const fetchJson = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        connected = false;
        return Response.json({ disconnected: true });
      }
      return Response.json({ configured: true, installations: connected ? [installation] : [] });
    });
    render(<GitHubConnections fetchJson={fetchJson} callbackStatus="state_invalid" />);
    expect(screen.getByRole("alert")).toHaveTextContent("could not be completed");
    fireEvent.click(await screen.findByRole("button", { name: /@nap-team/ }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect connection" }));
    await screen.findByText("No GitHub connections yet.");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fetchJson.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true);
  });
});
