import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { GitHubConnections } from "./connections.tsx";

// jsdom parses `<dialog>` and implements none of its methods. These stand in for the two things
// the drawer relies on: `open` toggling, and focus going back to whatever had it at `showModal`.
const openers = new WeakMap<HTMLDialogElement, Element | null>();
beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    openers.set(this, document.activeElement);
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute("open");
    const opener = openers.get(this);
    if (opener instanceof HTMLElement) opener.focus();
    this.dispatchEvent(new Event("close"));
  };
});
afterEach(() => vi.restoreAllMocks());

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
    expect(screen.getByRole("link", { name: "Back to Connections" })).toHaveAttribute("href", back);
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
    // Nothing is asked of GitHub until the tab is opened, though the panel it names exists.
    expect(fetchJson).toHaveBeenCalledTimes(1);
    const tab = within(drawer).getByRole("tab", { name: "Repositories" });
    expect(document.getElementById(String(tab.getAttribute("aria-controls")))).toHaveAttribute(
      "role",
      "tabpanel",
    );

    fireEvent.click(tab);
    const list = await within(drawer).findByRole("list", { name: "Repositories" });
    const [docs, site, ...rest] = within(list).getAllByRole("link", { name: /^nap-team\// });
    expect(rest).toEqual([]);
    expect(within(docs!).getByText("nap-team/docs")).toBeVisible();
    expect(within(docs!).getByText("Public")).toBeVisible();
    expect(within(site!).getByText("nap-team/site")).toBeVisible();
    expect(within(site!).queryByText("Public")).toBeNull();
    fireEvent.change(within(drawer).getByLabelText("Search repositories"), {
      target: { value: "SITE" },
    });
    const [only, ...others] = within(list).getAllByRole("link", { name: /^nap-team\// });
    expect(others).toEqual([]);
    expect(within(only!).getByText("nap-team/site")).toBeVisible();
    expect(within(drawer).getByText(/Last fetched: just now/)).toBeVisible();

    fireEvent.click(within(drawer).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("moves between the drawer's tabs with the arrow keys and closes from its breadcrumb", async () => {
    const fetchJson = vi.fn(async (url: string) =>
      url.endsWith("/repositories")
        ? Response.json({ repositories })
        : Response.json({ configured: true, installations: [installation] }),
    );
    render(<GitHubConnections fetchJson={fetchJson} />);
    fireEvent.click(await screen.findByRole("button", { name: /@nap-team/ }));
    const drawer = screen.getByRole("dialog", { name: "@nap-team" });
    const general = within(drawer).getByRole("tab", { name: "General", selected: true });
    general.focus();
    fireEvent.keyDown(general, { key: "ArrowRight" });
    const repositoriesTab = within(drawer).getByRole("tab", {
      name: "Repositories",
      selected: true,
    });
    expect(repositoriesTab).toHaveFocus();
    await within(drawer).findByRole("list", { name: "Repositories" });
    fireEvent.keyDown(repositoriesTab, { key: "ArrowLeft" });
    expect(within(drawer).getByRole("tab", { name: "General", selected: true })).toHaveFocus();

    fireEvent.click(within(drawer).getByRole("button", { name: "Connections" }));
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

  it("closes the drawer after a disconnect and gives focus back to the connection's row", async () => {
    let status = "active";
    const fetchJson = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === "DELETE") {
        status = "disconnected";
        return Response.json({ disconnected: true });
      }
      // The store keeps a disconnected installation and lists it with its new status.
      return Response.json({ configured: true, installations: [{ ...installation, status }] });
    });
    render(<GitHubConnections fetchJson={fetchJson} callbackStatus="state_invalid" />);
    expect(screen.getByRole("alert")).toHaveTextContent("could not be completed");
    const row = await screen.findByRole("button", { name: /@nap-team/ });
    row.focus();
    fireEvent.click(row);
    const disconnect = screen.getByRole("button", { name: "Disconnect connection" });
    disconnect.focus();
    fireEvent.click(disconnect);
    await waitFor(() => expect(row).toHaveTextContent("Disconnected"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(row).toHaveFocus();
    expect(fetchJson.mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(true);
  });

  it("shows a drawer only its own failures, from either tab", async () => {
    const fetchJson = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/connect") || init?.method === "DELETE")
        return Response.json({ error: "GitHub is unavailable." }, { status: 503 });
      return url.endsWith("/repositories")
        ? Response.json({ repositories })
        : Response.json({ configured: true, installations: [installation] });
    });
    render(<GitHubConnections fetchJson={fetchJson} />);
    fireEvent.click(await screen.findByRole("button", { name: "Add connection" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("GitHub is unavailable.");
    fireEvent.click(screen.getByRole("button", { name: /@nap-team/ }));
    const drawer = screen.getByRole("dialog", { name: "@nap-team" });
    expect(within(drawer).queryByRole("alert")).toBeNull();

    fireEvent.click(within(drawer).getByRole("button", { name: "Disconnect connection" }));
    const failure = await within(drawer).findByRole("alert");
    fireEvent.click(within(drawer).getByRole("tab", { name: "Repositories" }));
    await within(drawer).findByRole("list", { name: "Repositories" });
    expect(failure).toBeVisible();
  });

  it("closes only the drawer of the connection a late disconnect was for", async () => {
    const other = { ...installation, installationId: 43, accountLogin: "other-team" };
    let finish: (response: Response) => void = () => {};
    const fetchJson = vi.fn((_url: string, init?: RequestInit) =>
      init?.method === "DELETE"
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(
            Response.json({ configured: true, installations: [installation, other] }),
          ),
    );
    render(<GitHubConnections fetchJson={fetchJson} />);
    fireEvent.click(await screen.findByRole("button", { name: /@nap-team/ }));
    fireEvent.click(screen.getByRole("button", { name: "Disconnect connection" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: /@other-team/ }));
    finish(Response.json({ disconnected: true }));
    await waitFor(() => expect(screen.queryByText("Updating GitHub access…")).toBeNull());
    expect(screen.getByRole("dialog", { name: "@other-team" })).toHaveAttribute("open");
  });

  it("stays open through StrictMode's rehearsal unmount", async () => {
    // A browser queues the `close` event, so the one from the rehearsal's close arrives after the
    // dialog has opened again. The stand-in above fires it at once and could not show this.
    vi.spyOn(HTMLDialogElement.prototype, "close").mockImplementation(function (
      this: HTMLDialogElement,
    ) {
      this.removeAttribute("open");
      setTimeout(() => this.dispatchEvent(new Event("close")));
    });
    render(
      <StrictMode>
        <GitHubConnections
          fetchJson={async () => Response.json({ configured: true, installations: [installation] })}
        />
      </StrictMode>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /@nap-team/ }));
    await act(() => new Promise((resolve) => setTimeout(resolve, 10)));
    expect(screen.getByRole("dialog", { name: "@nap-team" })).toHaveAttribute("open");
  });
});
