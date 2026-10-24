import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import { ConnectionsOverview } from "./connections-overview.tsx";

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
const draftId = "b20e2120-867c-4eb7-bdd6-cdd1c33bac1e";

function api(github: unknown, key: unknown) {
  return async (url: string) =>
    Response.json(url.endsWith("/account/api-key") ? key : github, { status: 200 });
}

describe("Connections overview", () => {
  it("shows each provider's state and links GitHub's page without losing the draft", async () => {
    render(
      <ConnectionsOverview
        draftId={draftId}
        fetchJson={api(
          {
            configured: true,
            installations: [installation, { ...installation, status: "removed" }],
          },
          { configured: true, platform: "openrouter", hint: "…a1b2" },
        )}
      />,
    );
    const github = screen.getByRole("link", { name: "GitHub" });
    expect(github).toHaveAttribute("href", `/settings/connections/github?draft=${draftId}`);
    await waitFor(() => expect(github).toHaveAccessibleDescription("Connected · 1 account"));
    const key = await screen.findByRole("button", { name: "OpenRouter" });
    expect(key).toHaveAccessibleDescription("Connected · …a1b2");
    expect(screen.getByRole("link", { name: "Back to draft" })).toHaveAttribute(
      "href",
      `/dashboard?draft=${draftId}&repositories=1`,
    );
    const rail = within(screen.getByRole("navigation", { name: "Settings" }));
    const railLink = rail.getByRole("link", { name: "Connections" });
    expect(railLink).toHaveAttribute("href", `/settings/connections?draft=${draftId}`);
    expect(railLink).toHaveAttribute("aria-current", "page");

    fireEvent.click(key);
    expect(screen.getByRole("dialog", { name: "Your API key" })).toBeVisible();
  });

  it("says a connected subscription cannot run turns yet", () => {
    render(<ConnectionsOverview fetchJson={api({ configured: false }, { configured: false })} />);
    const row = screen.getByRole("link", { name: "Claude and ChatGPT subscriptions" });
    expect(row).toHaveAttribute("href", "/settings/providers");
    expect(row).toHaveAccessibleDescription("Running turns on a subscription isn't available yet");
    expect(screen.getByText("Bring your own key for the paid models")).toBeVisible();
    expect(screen.queryByText(/plan you already pay for/i)).not.toBeInTheDocument();
    expect(
      screen.queryByText(/your own subscription, for the paid models/i),
    ).not.toBeInTheDocument();
  });

  it("marks GitHub as needing attention when its only connections are in trouble", async () => {
    const view = render(
      <ConnectionsOverview
        fetchJson={api(
          {
            configured: true,
            installations: [
              { ...installation, status: "suspended" },
              { ...installation, installationId: 43, status: "disconnected" },
            ],
          },
          { configured: false },
        )}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "GitHub" })).toHaveAccessibleDescription(
        "Needs attention",
      ),
    );
    view.unmount();

    // Disconnecting was the owner's own choice, so on its own it is not trouble.
    render(
      <ConnectionsOverview
        fetchJson={api(
          { configured: true, installations: [{ ...installation, status: "disconnected" }] },
          { configured: false },
        )}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "GitHub" })).toHaveAccessibleDescription(
        "Not connected",
      ),
    );
  });

  it("says when a provider is not connected or not offered by this deployment", async () => {
    render(
      <ConnectionsOverview
        fetchJson={api({ configured: false, installations: [] }, { configured: false })}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("link", { name: "GitHub" })).toHaveAccessibleDescription(
        "Not available on this deployment",
      ),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "API key", description: "Not connected" }),
      ).toBeVisible(),
    );
  });
});
