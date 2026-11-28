import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { GitHubConnections } from "./connections.tsx";

const installation = {
  installationId: 42,
  userId: "a70e2120-867c-4eb7-bdd6-cdd1c33bac1e",
  githubUserId: 9,
  githubLogin: "owner",
  accountLogin: "nap-team",
  accountType: "Organization",
  status: "active",
};
const draftId = "b20e2120-867c-4eb7-bdd6-cdd1c33bac1e";

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

  it("carries a draft through Add connection and every way back", async () => {
    const navigate = vi.fn();
    const fetchJson = vi.fn(async (url: string, _init?: RequestInit) =>
      url.endsWith("/connect")
        ? Response.json({ url: "https://github.com/login/oauth/authorize?state=draft" })
        : Response.json({ configured: true, installations: [] }),
    );
    render(<GitHubConnections fetchJson={fetchJson} navigate={navigate} draftId={draftId} />);
    const back = `/settings/connections?draft=${draftId}`;
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(within(crumbs).getByRole("link", { name: "Connections" })).toHaveAttribute("href", back);
    const rail = screen.getByRole("navigation", { name: "Settings" });
    const railLink = within(rail).getByRole("link", { name: "Connections" });
    expect(railLink).toHaveAttribute("href", back);
    expect(railLink).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("link", { name: "Back to app" })).toHaveAttribute(
      "href",
      `/dashboard?draft=${draftId}&repositories=1`,
    );

    fireEvent.click(await screen.findByRole("button", { name: "Add connection" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    const body = fetchJson.mock.calls.find(([url]) => url.endsWith("/connect"))?.[1]?.body;
    expect(JSON.parse(String(body))).toEqual({ draftId });
  });

  it("opens connection settings without loading repositories", async () => {
    const fetchJson = vi.fn(async () =>
      Response.json({ configured: true, installations: [installation] }),
    );
    render(<GitHubConnections fetchJson={fetchJson} />);
    const account = await screen.findByRole("region", { name: "@nap-team" });
    expect(
      within(account).getByRole("link", { name: "Manage access for nap-team" }),
    ).toHaveAttribute(
      "href",
      "https://github.com/organizations/nap-team/settings/installations/42",
    );
    const summary = within(account).getByText("Connection settings");
    expect(summary.closest("details")).not.toHaveAttribute("open");
    fireEvent.click(summary);
    expect(within(account).getByText("@owner")).toBeVisible();
    expect(fetchJson).toHaveBeenCalledTimes(1);
  });

  it("reports a failed disconnect and returns focus to the disclosure after retry", async () => {
    let status = "active";
    let allowDisconnect = false;
    const fetchJson = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        if (!allowDisconnect) return Response.json({ error: "Try again." }, { status: 503 });
        status = "disconnected";
        return Response.json({ disconnected: true });
      }
      return Response.json({ configured: true, installations: [{ ...installation, status }] });
    });
    render(<GitHubConnections fetchJson={fetchJson} />);
    const summary = await screen.findByText("Connection settings");
    fireEvent.click(summary);
    const disconnect = screen.getByRole("button", { name: "Disconnect" });
    disconnect.focus();
    fireEvent.click(disconnect);
    const account = screen.getByRole("region", { name: "@nap-team" });
    expect(await within(account).findByRole("alert")).toHaveTextContent("Try again.");

    allowDisconnect = true;
    disconnect.focus();
    fireEvent.click(disconnect);
    await screen.findByText("Disconnected");
    expect(summary).toHaveFocus();
    expect(screen.queryByRole("button", { name: "Disconnect" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeVisible();
  });

  it("reconnects a suspended installation with its ID", async () => {
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
    fireEvent.click(screen.getByText("Connection settings"));
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledOnce());
    expect(fetchJson.mock.calls.find(([url]) => url.endsWith("/connect"))?.[1]?.body).toBe(
      JSON.stringify({ installationId: 42 }),
    );
  });

  it("shows the OAuth result and preserves the draft on return", async () => {
    const fetchJson = async () => Response.json({ configured: true, installations: [] });
    const { rerender } = render(
      <GitHubConnections fetchJson={fetchJson} draftId={draftId} callbackStatus="connected" />,
    );
    expect(screen.getByRole("link", { name: "Back to draft" })).toHaveAttribute(
      "href",
      `/dashboard?draft=${draftId}&repositories=1`,
    );
    rerender(<GitHubConnections fetchJson={fetchJson} callbackStatus="state_invalid" />);
    expect(screen.getByRole("alert")).toHaveTextContent("could not be completed");
    await screen.findByText("No GitHub connections yet.");
  });
});
