"use client";

import { ExecutionPreferenceSchema, type ExecutionSelection } from "@nap/shared/execution-target";
import {
  type SubscriptionCatalog,
  SubscriptionCatalogSchema,
} from "@nap/shared/subscription-protocol";
import { useCallback, useEffect, useRef, useState } from "react";
import { credentialedFetch } from "../api/credentialed-fetch.ts";
import type { FetchJson } from "../files/use-project-files.ts";

type State = { sessionId: string | undefined } & (
  | { status: "loading" | "saving" | "error" }
  | { status: "ready"; selection: ExecutionSelection | null }
);
const BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

/** A failed read or write cannot turn an unknown billing preference into the API default. */
export function useSessionExecution(options: {
  sessionId: string | undefined;
  baseUrl?: string;
  fetchJson?: FetchJson;
}) {
  const { sessionId, baseUrl = BASE_URL } = options;
  const fetchRef = useRef(options.fetchJson ?? credentialedFetch);
  fetchRef.current = options.fetchJson ?? credentialedFetch;
  const [state, setState] = useState<State>({ sessionId, status: "loading" });
  const [catalog, setCatalog] = useState<{ sessionId: string; value: SubscriptionCatalog }>();
  const [revision, setRevision] = useState(0);
  const epoch = useRef(0);
  const currentSession = useRef(sessionId);
  currentSession.current = sessionId;

  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry explicitly re-reads the server preference and catalog.
  useEffect(() => {
    const id = ++epoch.current;
    setState({ sessionId, status: "loading" });
    if (sessionId === undefined) return;
    const controller = new AbortController();
    const current = () => !controller.signal.aborted && epoch.current === id;
    void (async () => {
      try {
        const response = await fetchRef.current(
          `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/execution`,
          { signal: controller.signal },
        );
        if (!response.ok) throw new Error("Preference unavailable");
        const preference = ExecutionPreferenceSchema.parse(await response.json());
        if (current()) setState({ sessionId, status: "ready", selection: preference.selection });
      } catch {
        if (current()) setState({ sessionId, status: "error" });
      }
    })();
    void (async () => {
      try {
        const response = await fetchRef.current(`${baseUrl}/providers/targets`, {
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("Catalog unavailable");
        const value = SubscriptionCatalogSchema.parse(await response.json());
        if (!controller.signal.aborted) setCatalog({ sessionId, value });
      } catch {
        if (!controller.signal.aborted) setCatalog(undefined);
      }
    })();
    return () => controller.abort();
  }, [sessionId, baseUrl, revision]);

  const choose = useCallback(
    async (selection: ExecutionSelection) => {
      if (sessionId === undefined) return false;
      const id = ++epoch.current;
      setState({ sessionId, status: "saving" });
      try {
        const response = await fetchRef.current(
          `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/execution`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(selection),
          },
        );
        if (!response.ok) throw new Error("Selection unavailable");
        const preference = ExecutionPreferenceSchema.parse(await response.json());
        if (epoch.current !== id || currentSession.current !== sessionId) return false;
        // A successful response must name the exact intent we sent, never a server default.
        const saved = preference.selection;
        if (
          saved === null ||
          saved.kind !== selection.kind ||
          saved.model !== selection.model ||
          (selection.kind === "subscription" &&
            (saved.kind !== "subscription" || saved.accountId !== selection.accountId))
        )
          throw new Error("Selection was not confirmed");
        setState({ sessionId, status: "ready", selection: preference.selection });
        return true;
      } catch {
        if (epoch.current === id && currentSession.current === sessionId)
          setState({ sessionId, status: "error" });
        return false;
      }
    },
    [baseUrl, sessionId],
  );

  const active = state.sessionId === sessionId ? state : { status: "loading" as const };
  const selection = active.status === "ready" ? active.selection : null;
  const accounts =
    catalog !== undefined && catalog.sessionId === sessionId ? catalog.value.accounts : [];
  const account =
    selection?.kind === "subscription"
      ? accounts.find((item) => item.account.id === selection.accountId)
      : undefined;
  const model =
    selection?.kind === "subscription"
      ? account?.models.find((item) => item.id === selection.model)
      : undefined;
  let message: string | undefined;
  if (active.status === "error")
    message =
      "Could not confirm this session's account selection. Retry or choose an account explicitly.";
  else if (active.status === "loading") message = "Loading account selection…";
  else if (active.status === "saving") message = "Saving account selection…";
  else if (selection?.kind === "subscription") {
    if (account === undefined || model === undefined || account.availability === "unavailable")
      message =
        "The selected subscription is unavailable. Choose another account or model explicitly.";
    else if (account.availability === "disabled")
      message = "The selected subscription account is disabled. Enable it in Providers.";
    else if (account.availability === "sign_in_required")
      message = "Sign in to the selected account in Providers before sending.";
    else if (account.availability === "refreshing")
      message = "The selected subscription is refreshing. Retry shortly.";
  }
  return {
    status: active.status,
    selection,
    accounts,
    blocked: message !== undefined,
    message,
    supportsImages: model?.supportsImages,
    choose,
    reload: () => setRevision((value) => value + 1),
  };
}
