import type { ProviderAccountView } from "@nap/shared/provider-accounts-protocol";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { FetchJson } from "../files/use-project-files.ts";
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

const failing =
  (
    api: ReturnType<typeof fakeProvidersApi>,
    when: (method: string, url: string) => boolean,
  ): FetchJson =>
  async (url, init) =>
    when(init?.method ?? "GET", url)
      ? new Response(JSON.stringify({ error: "Runner down." }), { status: 500 })
      : api.fetchJson(url, init);

function renderPage(api: ReturnType<typeof fakeProvidersApi>, confirm = () => true) {
  return render(<ProvidersPage fetchJson={api.fetchJson} baseUrl={FAKE_API} confirm={confirm} />);
}

describe("the provider list", () => {
  it("Escape restores the display name without saving", async () => {
    const api = fakeProvidersApi({ accounts: [CLAUDE] });
    renderPage(api);
    const field = await screen.findByRole("textbox", { name: "Display name" });
    act(() => field.focus());
    fireEvent.change(field, { target: { value: "Personal" } });
    fireEvent.keyDown(field, { key: "Escape" });
    await act(async () => {});
    expect(api.requests.filter((request) => request.method === "PATCH")).toEqual([]);
    expect(field).toHaveValue("Work");
  });

  it("keeps an uncommitted display name when a refresh changes the saved label", async () => {
    const api = fakeProvidersApi({ accounts: [CLAUDE] });
    renderPage(api);
    const field = await screen.findByRole("textbox", { name: "Display name" });
    fireEvent.change(field, { target: { value: "Personal" } });
    const account = api.accounts[0];
    if (account === undefined) throw new Error("no account");
    account.label = "Other tab";
    fireEvent.click(screen.getByRole("button", { name: "Refresh provider status" }));
    await screen.findByRole("button", { name: "Select Other tab" });
    await act(async () => {});
    expect(field).toHaveValue("Personal");
    fireEvent.blur(field);
    await screen.findByRole("button", { name: "Select Personal" });
    expect(field).toHaveValue("Personal");
  });

  it("accepts a normalized saved label and follows a later external rename without resaving", async () => {
    const api = fakeProvidersApi({ accounts: [CLAUDE] });
    renderPage(api);
    const field = await screen.findByRole("textbox", { name: "Display name" });
    act(() => field.focus());
    fireEvent.change(field, { target: { value: " Personal " } });
    act(() => field.blur());
    await screen.findByRole("button", { name: "Select Personal" });
    await act(async () => {});
    const account = api.accounts[0];
    if (account === undefined) throw new Error("no account");
    expect(account.label).toBe("Personal");
    account.label = "Other tab";
    fireEvent.click(screen.getByRole("button", { name: "Refresh provider status" }));
    await screen.findByRole("button", { name: "Select Other tab" });
    await act(async () => {});
    act(() => field.focus());
    await act(async () => field.blur());
    expect(api.requests.filter((request) => request.method === "PATCH")).toEqual([
      { method: "PATCH", path: `/providers/accounts/${CLAUDE.id}`, body: { label: "Personal" } },
    ]);
    expect(field).toHaveValue("Other tab");
  });

  it.each(["Newer draft", "Work"])(
    "keeps a newer %s draft when a pending normalized save is acknowledged",
    async (newer) => {
      const api = fakeProvidersApi({ accounts: [CLAUDE] });
      let release: (() => void) | undefined;
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      const fetchJson: FetchJson = async (url, init) => {
        if (init?.method === "PATCH") await ready;
        return api.fetchJson(url, init);
      };
      render(<ProvidersPage fetchJson={fetchJson} baseUrl={FAKE_API} />);
      const field = await screen.findByRole("textbox", { name: "Display name" });
      act(() => field.focus());
      fireEvent.change(field, { target: { value: " Personal " } });
      act(() => field.blur());
      act(() => field.focus());
      fireEvent.change(field, { target: { value: newer } });
      await act(async () => release?.());
      await screen.findByRole("button", { name: "Select Personal" });
      await act(async () => {});
      expect(field).toHaveValue(newer);
      act(() => field.blur());
      await screen.findByRole("button", { name: `Select ${newer}` });
      expect(
        api.requests.filter((request) => request.method === "PATCH").map((request) => request.body),
      ).toEqual([{ label: "Personal" }, { label: newer }]);
    },
  );

  it.each(["toggle", "delete"])("reports a refused %s beside its control", async (action) => {
    const api = fakeProvidersApi({ accounts: [CLAUDE] });
    const fetchJson = failing(
      api,
      (method) => method === (action === "toggle" ? "PATCH" : "DELETE"),
    );
    render(<ProvidersPage fetchJson={fetchJson} baseUrl={FAKE_API} confirm={() => true} />);
    fireEvent.click(
      await screen.findByRole(action === "toggle" ? "switch" : "button", {
        name: action === "toggle" ? "Enable Work" : "Delete Work",
      }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Runner down.");
    expect(screen.getByRole("button", { name: "Select Work" })).toBeInTheDocument();
  });

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

  it("disables the account switch while its change is pending", async () => {
    const api = fakeProvidersApi({ accounts: [CLAUDE] });
    let release: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchJson: FetchJson = async (url, init) => {
      if (init?.method === "PATCH") await ready;
      return api.fetchJson(url, init);
    };
    render(<ProvidersPage fetchJson={fetchJson} baseUrl={FAKE_API} />);
    const toggle = await screen.findByRole("switch", { name: "Enable Work" });
    fireEvent.click(toggle);
    expect(toggle).toBeDisabled();
    fireEvent.click(toggle);
    await act(async () => {
      release?.();
    });
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
    expect(toggle).toBeEnabled();
    expect(api.requests.filter((request) => request.method === "PATCH")).toHaveLength(1);
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
    const confirm = vi.fn(() => false);
    renderPage(api, confirm);

    fireEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(confirm).toHaveBeenCalledWith("Sign out of Work? Session history is kept.");
    expect(api.requests.some((request) => request.path.endsWith("/sign-out"))).toBe(false);
    confirm.mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(confirm).toHaveBeenCalledTimes(2);

    await screen.findByRole("button", { name: "Sign in to Claude Code" });
    expect(api.requests).toContainEqual({
      method: "POST",
      path: `/providers/accounts/${CLAUDE.id}/sign-out`,
      body: undefined,
    });
  });
});

describe("adding a provider", () => {
  it("keeps Add provider disabled until the list loads", async () => {
    const api = fakeProvidersApi();
    let release: (() => void) | undefined;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchJson: FetchJson = async (url, init) => {
      if (url.endsWith("/providers") && (init?.method ?? "GET") === "GET") await ready;
      return api.fetchJson(url, init);
    };
    render(<ProvidersPage fetchJson={fetchJson} baseUrl={FAKE_API} />);
    expect(screen.getByRole("button", { name: "Add provider" })).toBeDisabled();
    await act(async () => {
      release?.();
    });
    const list = await screen.findByRole("navigation", { name: "Providers" });
    fireEvent.click(within(list).getByRole("button", { name: "Add provider" }));
    expect(screen.getByRole("dialog", { name: "Add provider" })).toBeInTheDocument();
  });
  it("shows a wizard sign-in start failure on the created account", async () => {
    const api = fakeProvidersApi();
    let refuseStart = true;
    const fetchJson = failing(
      api,
      (method, url) => refuseStart && method === "POST" && url.endsWith("/sign-in"),
    );
    render(<ProvidersPage fetchJson={fetchJson} baseUrl={FAKE_API} />);
    fireEvent.click(
      within(await screen.findByRole("navigation", { name: "Providers" })).getByRole("button", {
        name: "Add provider",
      }),
    );
    const dialog = screen.getByRole("dialog", { name: "Add provider" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Continue with ChatGPT" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(await screen.findByRole("alert")).toHaveTextContent("Runner down.");
    expect(screen.getByRole("button", { name: "Continue with ChatGPT" })).toBeInTheDocument();
    expect(api.accounts).toHaveLength(1);
    refuseStart = false;
    fireEvent.click(screen.getByRole("button", { name: "Continue with ChatGPT" }));
    await screen.findByRole("link", { name: "Open browser" });
    fireEvent.click(screen.getByRole("button", { name: "Select Free models" }));
    fireEvent.click(screen.getByRole("button", { name: "Select Codex" }));
    await act(async () => {});
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("walks Claude through provider, identity and config, then shows its terminal login", async () => {
    const api = fakeProvidersApi();
    renderPage(api);

    fireEvent.click(
      within(await screen.findByRole("navigation", { name: "Providers" })).getByRole("button", {
        name: "Add provider",
      }),
    );
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

    fireEvent.click(
      within(await screen.findByRole("navigation", { name: "Providers" })).getByRole("button", {
        name: "Add provider",
      }),
    );
    const dialog = screen.getByRole("dialog", { name: "Add provider" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Continue with ChatGPT" }));

    const open = await screen.findByRole("link", { name: "Open browser" });
    expect(open).toHaveAttribute("href", "https://auth.openai.com/oauth/authorize");
    expect(open).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getByRole("button", { name: "Cancel sign-in" })).toBeInTheDocument();
  });

  it("only goes back to steps already done", async () => {
    renderPage(fakeProvidersApi());

    fireEvent.click(
      within(await screen.findByRole("navigation", { name: "Providers" })).getByRole("button", {
        name: "Add provider",
      }),
    );
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
    const api = fakeProvidersApi({ signInDrivers: [] });
    renderPage(api);

    fireEvent.click(
      within(await screen.findByRole("navigation", { name: "Providers" })).getByRole("button", {
        name: "Add provider",
      }),
    );
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

describe("provider runtime copy", () => {
  it.each(["claude", "codex"] as const)(
    "says the %s runtime and sign-in are unavailable in the account editor",
    async (driver) => {
      const runtime = driver === "claude" ? "Claude Code" : "Codex";
      renderPage(
        fakeProvidersApi({
          signInDrivers: [],
          accounts: [
            {
              ...CLAUDE,
              driver,
              auth: { status: "unauthenticated", email: null, plan: null },
            },
          ],
        }),
      );
      await screen.findByRole("textbox", { name: "Display name" });
      expect(screen.queryByText(/Nap runs|signed in as this account/i)).not.toBeInTheDocument();
      expect(
        screen.getByText(`${runtime} runtime and sign-in aren't available on this deployment yet.`),
      ).toBeInTheDocument();
    },
  );

  it.each(["claude", "codex"] as const)(
    "does not claim execution for an unauthenticated %s account when sign-in is available",
    async (driver) => {
      const runtime = driver === "claude" ? "Claude Code" : "Codex";
      renderPage(
        fakeProvidersApi({
          accounts: [
            {
              ...CLAUDE,
              driver,
              auth: { status: "unauthenticated", email: null, plan: null },
            },
          ],
        }),
      );
      await screen.findByRole("textbox", { name: "Display name" });
      expect(screen.queryByText(/Nap runs|signed in as this account/i)).not.toBeInTheDocument();
      expect(
        screen.getByText(`This account is for ${runtime}. Adding it doesn't start an agent.`),
      ).toBeInTheDocument();
    },
  );

  it.each([false, true])(
    "describes the wizard runtime without claiming execution when sign-in availability is %s",
    async (signInAvailable) => {
      renderPage(fakeProvidersApi({ signInDrivers: signInAvailable ? ["claude", "codex"] : [] }));
      fireEvent.click(
        within(await screen.findByRole("navigation", { name: "Providers" })).getByRole("button", {
          name: "Add provider",
        }),
      );
      const dialog = screen.getByRole("dialog", { name: "Add provider" });
      fireEvent.click(within(dialog).getByRole("radio", { name: "Claude" }));
      fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));
      fireEvent.click(within(dialog).getByRole("button", { name: "Next" }));
      expect(
        within(dialog).queryByText(/Nap runs|signed in as this account/i),
      ).not.toBeInTheDocument();
      expect(
        within(dialog).getByText(
          signInAvailable
            ? "This account is for Claude Code. Adding it doesn't start an agent."
            : "Claude Code runtime and sign-in aren't available on this deployment yet.",
        ),
      ).toBeInTheDocument();
    },
  );
});

it("keeps an unavailable provider disabled while another provider can sign in", async () => {
  renderPage(
    fakeProvidersApi({
      signInDrivers: ["claude"],
      accounts: [
        {
          ...CLAUDE,
          driver: "codex",
          auth: { status: "unauthenticated", email: null, plan: null },
        },
      ],
    }),
  );
  expect(await screen.findByRole("button", { name: "Continue with ChatGPT" })).toBeDisabled();
});

it("hands a browser callback back to its account without placing it in a navigation URL", async () => {
  const account: ProviderAccountView = {
    ...CLAUDE,
    driver: "codex",
    auth: { status: "unauthenticated", email: null, plan: null },
    signIn: {
      flowId: "00000000-0000-4000-8000-000000000099",
      phase: "waiting",
      interaction: { type: "browser", url: "https://provider.example/authorize?state=bound" },
      message: null,
    },
  };
  const api = fakeProvidersApi({ accounts: [account] });
  renderPage(api);
  const field = await screen.findByLabelText("Sign-in callback URL");
  const redirect = "https://nap.example/callback?code=private-one-use&state=bound";
  fireEvent.change(field, { target: { value: redirect } });
  fireEvent.click(screen.getByRole("button", { name: "Complete sign-in" }));
  await waitFor(() =>
    expect(api.requests).toContainEqual({
      method: "POST",
      path: `/providers/accounts/${account.id}/sign-in/complete`,
      body: { flowId: account.signIn?.flowId, redirect },
    }),
  );
  await waitFor(() =>
    expect(screen.queryByLabelText("Sign-in callback URL")).not.toBeInTheDocument(),
  );
  expect(window.location.href).not.toContain("private-one-use");
});
