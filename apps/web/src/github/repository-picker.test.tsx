import { SIGN_IN_REQUIRED } from "@nap/shared/api-error";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RepositoryPicker } from "./repository-picker.tsx";

const installation = {
  installationId: 1,
  userId: "00000000-0000-4000-8000-000000000001",
  githubUserId: 10,
  githubLogin: "river",
  accountLogin: "example",
  accountType: "Organization",
  status: "active",
};
const repositories = [
  { id: 11, fullName: "example/storefront", defaultBranch: "main", private: true },
  { id: 12, fullName: "river/docs", defaultBranch: "main", private: false },
];

describe("repository autocomplete", () => {
  it("lists authorized repositories from every installation and selects with the keyboard", async () => {
    const fetchJson = vi.fn(async (url: string) =>
      Response.json(
        url.endsWith("/connections")
          ? {
              configured: true,
              installations: [installation, { ...installation, installationId: 2 }],
            }
          : { repositories: url.includes("/1/") ? [repositories[0]] : [repositories[1]] },
      ),
    );
    const onSelect = vi.fn();
    render(
      <RepositoryPicker
        fetchJson={fetchJson}
        onSelect={onSelect}
        onClose={vi.fn()}
        onConnect={vi.fn()}
      />,
    );
    await screen.findByRole("option", { name: "example/storefront" });
    expect(screen.getByRole("option", { name: "river/docs" })).toBeVisible();
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "river/" } });
    expect(screen.queryByRole("option", { name: "example/storefront" })).toBeNull();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith({ installationId: 2, repository: repositories[1] });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps disconnected state compact and delegates navigation to the saved-draft flow", async () => {
    const onConnect = vi.fn();
    render(
      <RepositoryPicker
        fetchJson={async () => Response.json({ configured: true, installations: [] })}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onConnect={onConnect}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Settings → Connections" }));
    expect(onConnect).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("retains successful installations when another is revoked and offers retry", async () => {
    const fetchJson = vi.fn(async (url: string) =>
      url.endsWith("/connections")
        ? Response.json({
            configured: true,
            installations: [installation, { ...installation, installationId: 2 }],
          })
        : url.includes("/1/")
          ? Response.json({ repositories })
          : Response.json({ error: "Access revoked." }, { status: 403 }),
    );
    const onClose = vi.fn();
    render(
      <RepositoryPicker
        fetchJson={fetchJson}
        onSelect={vi.fn()}
        onClose={onClose}
        onConnect={vi.fn()}
      />,
    );
    await screen.findByText(/Access revoked/);
    expect(screen.getAllByRole("option")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(fetchJson).toHaveBeenCalledTimes(6));
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("asks a guest to sign in instead of showing an error and a retry that cannot work", async () => {
    const onClose = vi.fn();
    render(
      <RepositoryPicker
        fetchJson={async () =>
          Response.json(
            {
              error: "Sign in to a permanent nap account to connect GitHub.",
              code: SIGN_IN_REQUIRED,
            },
            { status: 403 },
          )
        }
        onSelect={vi.fn()}
        onClose={onClose}
        onConnect={vi.fn()}
      />,
    );
    expect(await screen.findByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/sign-in?upgrade=1",
    );
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(screen.queryByText(/write access/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("announces the guest panel and lets the keyboard reach its way out", async () => {
    const onClose = vi.fn();
    render(
      <RepositoryPicker
        fetchJson={async () =>
          Response.json(
            { error: "Sign in to a permanent nap account.", code: SIGN_IN_REQUIRED },
            { status: 403 },
          )
        }
        onSelect={vi.fn()}
        onClose={onClose}
        onConnect={vi.fn()}
      />,
    );
    await screen.findByRole("link", { name: "Sign in" });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Working on a repository needs a permanent account.",
    );
    // Tab from the filter would otherwise close the picker before focus reached Sign in.
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Tab" });
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Sign in" })).not.toHaveAttribute("tabindex");
    expect(screen.getByRole("button", { name: "Not now" })).not.toHaveAttribute("tabindex");
  });

  it("lets a keyboard guest leave the panel the way they came, or with Escape", async () => {
    const guest = async () =>
      Response.json(
        { error: "Sign in to a permanent nap account.", code: SIGN_IN_REQUIRED },
        { status: 403 },
      );
    const onClose = vi.fn();
    const view = render(
      <RepositoryPicker
        fetchJson={guest}
        onSelect={vi.fn()}
        onClose={onClose}
        onConnect={vi.fn()}
      />,
    );
    // Escape from the panel's own controls, not only from the filter.
    fireEvent.keyDown(await screen.findByRole("button", { name: "Not now" }), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
    // Back out of the filter with Shift+Tab, as before the panel became reachable.
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Tab", shiftKey: true });
    expect(onClose).toHaveBeenCalledTimes(2);
    // And Tab past Sign in leaves the picker rather than stranding it on screen.
    const outside = document.createElement("button");
    document.body.append(outside);
    fireEvent.blur(screen.getByRole("link", { name: "Sign in" }), { relatedTarget: outside });
    expect(onClose).toHaveBeenCalledTimes(3);
    outside.remove();
    view.unmount();
  });

  it("still closes on Tab once the list has loaded", async () => {
    const onClose = vi.fn();
    render(
      <RepositoryPicker
        fetchJson={async () => Response.json({ configured: true, installations: [] })}
        onSelect={vi.fn()}
        onClose={onClose}
        onConnect={vi.fn()}
      />,
    );
    await screen.findByText(/Connect GitHub in/);
    fireEvent.keyDown(screen.getByRole("combobox"), { key: "Tab" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows a refusal without the guest code as an error, whatever its wording says", async () => {
    render(
      <RepositoryPicker
        fetchJson={async () =>
          Response.json({ error: "Sign in again to list repositories." }, { status: 403 })
        }
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onConnect={vi.fn()}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Sign in again to list repositories.",
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
    expect(screen.queryByRole("link", { name: "Sign in" })).toBeNull();
  });

  it("offers a retry and the settings link when the connections cannot be reached", async () => {
    render(
      <RepositoryPicker
        fetchJson={async () => {
          throw new TypeError("Failed to fetch");
        }}
        onSelect={vi.fn()}
        onClose={vi.fn()}
        onConnect={vi.fn()}
      />,
    );
    expect(await screen.findByRole("alert")).toHaveTextContent(/Could not reach the server/);
    expect(screen.getByRole("button", { name: "Retry" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Manage access in Settings → Connections" }),
    ).toBeVisible();
    // The alert already says why the list is empty.
    expect(screen.queryByText("No repositories available with write access.")).toBeNull();
  });
});
