import type { ProviderAccountView } from "@nap/shared/provider-accounts-protocol";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { FAKE_API, fakeProvidersApi } from "../testing/fake-providers-api.ts";
import { GuestProviders } from "./live-providers.tsx";
import { ProvidersPage } from "./providers-page.tsx";

/**
 * The page against an in-memory API, asserted through what a person can see and press: roles and
 * accessible names, and the requests the page made. jsdom has no `<dialog>` methods; they are
 * stubbed to toggle `open`, as `api-key-panel.test.tsx` explains.
 */
beforeAll(() => {
  const proto = globalThis.HTMLDialogElement?.prototype;
  if (proto === undefined) return;
  proto.showModal ??= function showModal(this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  proto.close ??= function close(this: HTMLDialogElement) {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

const CLAUDE: ProviderAccountView = {
  id: "00000000-0000-4000-8000-0000000000c1",
  driver: "claude",
  label: "Work",
  enabled: true,
  auth: { status: "authenticated", email: "ada@example.com", plan: "Claude Max" },
  createdAt: "2026-10-23T09:00:00.000Z",
  signIn: null,
};

function renderPage(api: ReturnType<typeof fakeProvidersApi>, confirm = () => true) {
  return render(<ProvidersPage fetchJson={api.fetchJson} baseUrl={FAKE_API} confirm={confirm} />);
}

describe("the provider list", () => {
  it("lists the built-ins above each connected account, with its status", async () => {
    renderPage(fakeProvidersApi({ accounts: [CLAUDE] }));

    const list = await screen.findByRole("navigation", { name: "Providers" });
    const rows = within(list).getAllByRole("button", { name: /^Select / });
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
      "Select Free models",
      "Select API key",
      "Select Work",
    ]);
    expect(within(list).getByText("Authenticated · Claude Max")).toBeInTheDocument();
  });

  it("opens on the first connected account, signed in as whoever it is", async () => {
    renderPage(fakeProvidersApi({ accounts: [CLAUDE] }));

    expect(await screen.findByRole("heading", { name: "Work", level: 2 })).toBeInTheDocument();
    expect(screen.getByText(/Signed in as/)).toHaveTextContent(
      "Signed in as ada@example.com · Claude Max",
    );
    expect(screen.getByRole("button", { name: "Change account" })).toBeInTheDocument();
  });

  it("switches an account off without forgetting it", async () => {
    const api = fakeProvidersApi({ accounts: [CLAUDE] });
    renderPage(api);

    fireEvent.click(await screen.findByRole("switch", { name: "Enable Work" }));

    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Enable Work" })).toHaveAttribute(
        "aria-checked",
        "false",
      ),
    );
    expect(api.requests).toContainEqual({
      method: "PATCH",
      path: `/providers/accounts/${CLAUDE.id}`,
      body: { enabled: false },
    });
  });

  it("renames an account when the field is left", async () => {
    const api = fakeProvidersApi({ accounts: [CLAUDE] });
    renderPage(api);

    const field = await screen.findByRole("textbox", { name: "Display name" });
    fireEvent.change(field, { target: { value: "Personal" } });
    fireEvent.blur(field);

    await screen.findByRole("button", { name: "Select Personal" });
    expect(api.requests).toContainEqual({
      method: "PATCH",
      path: `/providers/accounts/${CLAUDE.id}`,
      body: { label: "Personal" },
    });
  });

  it("deletes an account only once the person confirms", async () => {
    const api = fakeProvidersApi({ accounts: [CLAUDE] });
    const confirm = vi.fn(() => false);
    const { rerender } = renderPage(api, confirm);

    fireEvent.click(await screen.findByRole("button", { name: "Delete Work" }));
    expect(api.requests.some((request) => request.method === "DELETE")).toBe(false);

    confirm.mockReturnValue(true);
    rerender(<ProvidersPage fetchJson={api.fetchJson} baseUrl={FAKE_API} confirm={confirm} />);
    fireEvent.click(screen.getByRole("button", { name: "Delete Work" }));

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Select Work" })).not.toBeInTheDocument(),
    );
  });

  it("signs out after asking", async () => {
    const api = fakeProvidersApi({ accounts: [CLAUDE] });
    renderPage(api);

    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));

    await screen.findByRole("button", { name: "Sign in to Claude Code" });
    expect(api.requests).toContainEqual({
      method: "POST",
      path: `/providers/accounts/${CLAUDE.id}/sign-out`,
      body: undefined,
    });
  });
});

describe("adding a provider", () => {
  it("walks Claude through provider, identity and config, then shows its terminal login", async () => {
    const api = fakeProvidersApi();
    renderPage(api);

    fireEvent.click(await screen.findByRole("button", { name: "Add provider" }));
    const dialog = screen.getByRole("dialog", { name: "Add provider" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Claude" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Label" }), {
      target: { value: "Work" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Sign in to Claude Code" }));

    const terminal = await screen.findByRole("log", { name: "Claude Code sign-in" });
    expect(terminal).toHaveTextContent("$ claude auth login");
    expect(screen.getByText("Complete sign-in in the terminal below.")).toBeInTheDocument();
    expect(api.requests.map((request) => `${request.method} ${request.path}`)).toContain(
      "POST /providers/accounts/00000000-0000-4000-8000-000000000001/sign-in",
    );
    expect(api.accounts[0]).toMatchObject({ driver: "claude", label: "Work" });
  });

  it("offers T3's ChatGPT shortcut, which skips straight to the browser sign-in", async () => {
    renderPage(fakeProvidersApi());

    fireEvent.click(await screen.findByRole("button", { name: "Add provider" }));
    const dialog = screen.getByRole("dialog", { name: "Add provider" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Continue with ChatGPT" }));

    const open = await screen.findByRole("link", { name: "Open browser" });
    expect(open).toHaveAttribute("href", "https://auth.openai.com/oauth/authorize");
    expect(open).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByRole("button", { name: "Cancel sign-in" })).toBeInTheDocument();
  });

  it("only goes back to steps already done", async () => {
    renderPage(fakeProvidersApi());

    fireEvent.click(await screen.findByRole("button", { name: "Add provider" }));
    const dialog = screen.getByRole("dialog", { name: "Add provider" });

    expect(within(dialog).getByRole("button", { name: "Config, step 3" })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("radio", { name: "Claude" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Provider, step 1" }));

    expect(within(dialog).getByRole("button", { name: "Provider, step 1" })).toHaveAttribute(
      "aria-current",
      "step",
    );
  });
});

describe("a deployment that cannot sign in yet", () => {
  it("still adds the account, and says why it cannot sign in rather than failing", async () => {
    const api = fakeProvidersApi({ signInAvailable: false });
    renderPage(api);

    fireEvent.click(await screen.findByRole("button", { name: "Add provider" }));
    const dialog = screen.getByRole("dialog", { name: "Add provider" });
    fireEvent.click(within(dialog).getByRole("radio", { name: "Claude" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add provider" }));

    expect(
      await screen.findByText("Signing in to a provider isn't available on this deployment yet."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in to Claude Code" })).toBeDisabled();
    expect(api.requests.some((request) => request.path.endsWith("/sign-in"))).toBe(false);
  });
});

describe("a guest", () => {
  it("is asked to sign in to nap before connecting anything", () => {
    render(<GuestProviders />);

    expect(
      screen.getByRole("heading", { name: "Use your Claude or ChatGPT subscription" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in" })).toHaveAttribute(
      "href",
      "/sign-in?upgrade=1",
    );
  });
});
