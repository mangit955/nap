import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { FAKE_API, fakeProvidersApi } from "../testing/fake-providers-api.ts";
import { useProviderAccounts } from "./use-provider-accounts.ts";

/** A `.test.tsx` because `renderHook` needs a DOM; see `use-api-key.test.tsx`. */

describe("useProviderAccounts", () => {
  it("loads the accounts and whether sign-in can run", async () => {
    const api = fakeProvidersApi({ signInAvailable: false });

    const { result } = renderHook(() =>
      useProviderAccounts({ fetchJson: api.fetchJson, baseUrl: FAKE_API }),
    );

    await waitFor(() => expect(result.current.state.kind).toBe("loaded"));
    expect(result.current.state).toMatchObject({
      kind: "loaded",
      value: { signInAvailable: false, accounts: [] },
    });
  });

  it("adds an account to the list it already holds, without reloading", async () => {
    const api = fakeProvidersApi();
    const { result } = renderHook(() =>
      useProviderAccounts({ fetchJson: api.fetchJson, baseUrl: FAKE_API }),
    );
    await waitFor(() => expect(result.current.state.kind).toBe("loaded"));

    let created: Awaited<ReturnType<typeof result.current.create>> | undefined;
    await act(async () => {
      created = await result.current.create({ driver: "claude", label: "Work" });
    });

    expect(created).toMatchObject({ ok: true, value: { driver: "claude", label: "Work" } });
    expect(result.current.state).toMatchObject({
      value: { accounts: [{ driver: "claude", label: "Work" }] },
    });
    expect(api.requests.filter((request) => request.method === "GET")).toHaveLength(1);
  });

  it("answers a refusal with the server's sentence and code", async () => {
    const api = fakeProvidersApi({ signInAvailable: false });
    const { result } = renderHook(() =>
      useProviderAccounts({ fetchJson: api.fetchJson, baseUrl: FAKE_API }),
    );
    await waitFor(() => expect(result.current.state.kind).toBe("loaded"));
    let id = "";
    await act(async () => {
      const created = await result.current.create({ driver: "claude" });
      if (created.ok) id = created.value.id;
    });

    let started: Awaited<ReturnType<typeof result.current.startSignIn>> | undefined;
    await act(async () => {
      started = await result.current.startSignIn(id);
    });

    expect(started).toEqual({
      ok: false,
      error: "Signing in is not available here.",
      code: "sign_in_unavailable",
    });
  });

  it("asks again while a sign-in is running, and stops once it is over", async () => {
    const api = fakeProvidersApi();
    const { result } = renderHook(() =>
      useProviderAccounts({ fetchJson: api.fetchJson, baseUrl: FAKE_API, pollMs: 10 }),
    );
    await waitFor(() => expect(result.current.state.kind).toBe("loaded"));
    let id = "";
    await act(async () => {
      const created = await result.current.create({ driver: "codex" });
      if (created.ok) id = created.value.id;
      await result.current.startSignIn(id);
    });

    // The provider finishes the login out of band; only a poll can learn of it.
    const account = api.accounts[0];
    if (account === undefined) throw new Error("no account");
    account.signIn = { flowId: "flow-1", phase: "succeeded", interaction: null, message: null };
    account.auth = { status: "authenticated", email: "ada@example.com", plan: "ChatGPT Plus" };

    await waitFor(() =>
      expect(result.current.state).toMatchObject({
        value: { accounts: [{ auth: { status: "authenticated" } }] },
      }),
    );
    const polls = api.requests.filter((request) => request.method === "GET").length;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(api.requests.filter((request) => request.method === "GET")).toHaveLength(polls);
  });
});
