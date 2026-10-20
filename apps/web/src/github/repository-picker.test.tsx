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
});
