import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
const repository = { id: 101, fullName: "nap-team/site", defaultBranch: "main", private: true };
const projectId = "b20e2120-867c-4eb7-bdd6-cdd1c33bac1e";

describe("GitHub connections", () => {
  it("shows a configuration requirement without an unusable connect button", async () => {
    render(
      <GitHubConnections
        fetchJson={async () => Response.json({ configured: false, installations: [] })}
      />,
    );
    expect(await screen.findByText(/not configured for this nap deployment/)).toBeVisible();
    expect(screen.queryByRole("button", { name: "Connect GitHub" })).toBeNull();
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

  it("imports a selected repository with its explicit environment, preserving the default branch", async () => {
    const navigate = vi.fn();
    const fetchJson = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith("/repositories")) return Response.json({ repositories: [repository] });
      if (url.endsWith("/import")) return Response.json({ projectId, sessionId: projectId });
      return Response.json({ configured: true, installations: [installation] });
    });
    render(<GitHubConnections fetchJson={fetchJson} navigate={navigate} />);
    await screen.findByRole("option", { name: "nap-team/site · private" });
    fireEvent.change(screen.getByLabelText("Repository"), { target: { value: "101" } });
    expect(screen.getByLabelText("Base branch")).toHaveValue("main");
    expect(screen.getByLabelText("Setup command")).toHaveValue("bun install --frozen-lockfile");
    fireEvent.change(screen.getByLabelText("Setup command"), { target: { value: "npm ci" } });
    fireEvent.change(screen.getByLabelText("Development command"), {
      target: { value: "npm run dev -- --host 0.0.0.0" },
    });
    fireEvent.change(screen.getByLabelText("Preview port"), { target: { value: "5173" } });
    fireEvent.click(screen.getByRole("button", { name: "Import repository" }));
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(`/p/${projectId}`));
    const request = fetchJson.mock.calls.find(([url]) => url.endsWith("/import"));
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({
      installationId: 42,
      repositoryId: 101,
      name: "site",
      baseBranch: "main",
      autoPublish: true,
      environment: {
        setupCommand: "npm ci",
        devCommand: "npm run dev -- --host 0.0.0.0",
        previewPort: 5173,
      },
    });
  });

  it("starts connection authorization on the server before leaving nap", async () => {
    const navigate = vi.fn();
    const fetchJson = vi.fn(async (url: string, _init?: RequestInit) =>
      url.endsWith("/connect")
        ? Response.json({ url: "https://github.com/login/oauth/authorize?state=opaque" })
        : Response.json({ configured: true, installations: [] }),
    );
    render(<GitHubConnections fetchJson={fetchJson} navigate={navigate} />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect GitHub" }));
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

  it("does not offer repository import from a suspended installation", async () => {
    const fetchJson = vi.fn(async () =>
      Response.json({
        configured: true,
        installations: [{ ...installation, status: "suspended" }],
      }),
    );
    render(<GitHubConnections fetchJson={fetchJson} />);
    expect(await screen.findByText("Suspended")).toBeVisible();
    expect(screen.getByRole("link", { name: "Manage access for nap-team" })).toHaveAttribute(
      "href",
      "https://github.com/organizations/nap-team/settings/installations/42",
    );
    expect(screen.queryByRole("button", { name: "Import repository" })).toBeNull();
    expect(fetchJson).toHaveBeenCalledTimes(1);
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
    fireEvent.click(await screen.findByRole("button", { name: "Disconnect nap-team" }));
    await screen.findByText("No GitHub connections yet.");
    expect(fetchJson.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true);
  });
});
