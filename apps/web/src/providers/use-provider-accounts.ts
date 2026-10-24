"use client";

/**
 * The provider accounts the settings page shows, and every change it can make to them.
 *
 * Each change answers with the account as it now is, and that answer replaces the one held here,
 * so the page never reloads the whole list to learn what it just did. The one thing a change
 * cannot report is a sign-in finishing: the person completes it in another tab or a terminal.
 * While any attempt is still running, the list is therefore read again every `pollMs`, and the
 * polling stops on its own once none is.
 */

import { ApiErrorSchema } from "@nap/shared/api-error";
import {
  type CompleteProviderSignIn,
  type CreateProviderAccount,
  type ProviderAccounts,
  ProviderAccountsSchema,
  type ProviderAccountView,
  ProviderAccountViewSchema,
  type UpdateProviderAccount,
} from "@nap/shared/provider-accounts-protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { z } from "zod";
import { credentialedFetch } from "../api/credentialed-fetch.ts";
import type { FetchJson } from "../files/use-project-files.ts";
import { isSigningIn } from "./account-status.ts";

const DEFAULT_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export type Outcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: string; code?: string | undefined };

export type ProvidersState =
  | { kind: "loading" }
  | { kind: "failed"; error: string }
  | { kind: "loaded"; value: ProviderAccounts };

async function request<T>(
  fetchJson: FetchJson,
  url: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<Outcome<T>> {
  try {
    const response = await fetchJson(url, init);
    const body: unknown = response.status === 204 ? null : await response.json().catch(() => null);
    if (!response.ok) {
      const refusal = ApiErrorSchema.safeParse(body);
      return refusal.success
        ? { ok: false, error: refusal.data.error, code: refusal.data.code }
        : { ok: false, error: "The server could not complete that. Try again." };
    }
    const parsed = schema.safeParse(body);
    return parsed.success
      ? { ok: true, value: parsed.data }
      : { ok: false, error: "The server sent an unexpected response. Try again." };
  } catch {
    return { ok: false, error: "Could not reach the server. Check your connection and try again." };
  }
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  ...(body === undefined
    ? {}
    : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
});

export function useProviderAccounts({
  fetchJson = credentialedFetch,
  baseUrl = DEFAULT_BASE_URL,
  pollMs = 1500,
}: {
  fetchJson?: FetchJson;
  baseUrl?: string;
  pollMs?: number;
} = {}) {
  const [state, setState] = useState<ProvidersState>({ kind: "loading" });
  const [refreshing, setRefreshing] = useState(false);
  // Polls carry the order they were asked in, so a poll sent before an applied change cannot
  // overwrite it when it arrives late. Changes themselves apply in response order.
  const asked = useRef(0);
  const applied = useRef(0);

  const load = useCallback(async () => {
    const ticket = ++asked.current;
    const result = await request(fetchJson, `${baseUrl}/providers`, ProviderAccountsSchema);
    if (ticket < applied.current) return;
    applied.current = ticket;
    setState((previous) =>
      result.ok
        ? { kind: "loaded", value: result.value }
        : // A failed poll keeps what is on screen; only a page that never loaded says it failed.
          previous.kind === "loaded"
          ? previous
          : { kind: "failed", error: result.error },
    );
  }, [fetchJson, baseUrl]);

  useEffect(() => {
    void load();
  }, [load]);

  const polling =
    state.kind === "loaded" && state.value.accounts.some((account) => isSigningIn(account.signIn));
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => void load(), pollMs);
    return () => clearInterval(timer);
  }, [polling, load, pollMs]);

  /** Puts one account's latest answer in place, or appends it if it is new. */
  const replace = useCallback((account: ProviderAccountView) => {
    applied.current = ++asked.current;
    setState((previous) => {
      if (previous.kind !== "loaded") return previous;
      const accounts = previous.value.accounts.some((item) => item.id === account.id)
        ? previous.value.accounts.map((item) => (item.id === account.id ? account : item))
        : [...previous.value.accounts, account];
      return { kind: "loaded", value: { ...previous.value, accounts } };
    });
  }, []);

  const change = useCallback(
    async (path: string, init: RequestInit): Promise<Outcome<ProviderAccountView>> => {
      const result = await request(
        fetchJson,
        `${baseUrl}/providers/accounts${path}`,
        ProviderAccountViewSchema,
        init,
      );
      if (result.ok) replace(result.value);
      return result;
    },
    [fetchJson, baseUrl, replace],
  );

  return {
    state,
    refreshing,
    refresh: useCallback(async () => {
      setRefreshing(true);
      await load();
      setRefreshing(false);
    }, [load]),
    create: useCallback(
      (input: CreateProviderAccount) => change("", json("POST", input)),
      [change],
    ),
    update: useCallback(
      (id: string, update: UpdateProviderAccount) => change(`/${id}`, json("PATCH", update)),
      [change],
    ),
    remove: useCallback(
      async (id: string): Promise<Outcome<null>> => {
        const result = await request(
          fetchJson,
          `${baseUrl}/providers/accounts/${id}`,
          // A 204 has no body; `null` is what `request` reads for one.
          z.null(),
          json("DELETE"),
        );
        if (result.ok) {
          applied.current = ++asked.current;
          setState((previous) =>
            previous.kind === "loaded"
              ? {
                  kind: "loaded",
                  value: {
                    ...previous.value,
                    accounts: previous.value.accounts.filter((account) => account.id !== id),
                  },
                }
              : previous,
          );
        }
        return result;
      },
      [fetchJson, baseUrl],
    ),
    startSignIn: useCallback((id: string) => change(`/${id}/sign-in`, json("POST")), [change]),
    completeSignIn: useCallback(
      (id: string, input: CompleteProviderSignIn) =>
        change(`/${id}/sign-in/complete`, json("POST", input)),
      [change],
    ),
    cancelSignIn: useCallback((id: string) => change(`/${id}/sign-in`, json("DELETE")), [change]),
    signOut: useCallback((id: string) => change(`/${id}/sign-out`, json("POST")), [change]),
  };
}

export type ProviderAccountsApi = ReturnType<typeof useProviderAccounts>;
