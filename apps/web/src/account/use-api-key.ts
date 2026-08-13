"use client";

/**
 * The key this person has saved, and the two ways to change it.
 *
 * A hook rather than a component so both places that need it — the welcome step and the
 * dashboard — share one idea of the state, and so neither has to know that "remove" and "save"
 * answer with the same body shape.
 *
 * `fetchJson` comes in through an argument the way `useModels` and `useProjectFiles` take
 * theirs, so every branch is drivable in a test without a network.
 */

import { KeyStatusSchema } from "@nap/shared/models-protocol";
import { useCallback, useEffect, useState } from "react";
import { credentialedFetch } from "../api/credentialed-fetch.ts";
import type { FetchJson } from "../files/use-project-files.ts";
import type { KeyState } from "./api-key-form.tsx";

const DEFAULT_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

/** What to say when the server would not say. */
const UNKNOWN = "That did not work. Try again in a moment.";
const UNREACHABLE = "We couldn't reach the server. Check your connection and try again.";

/** The shape of a refusal, which carries a sentence written for a person. */
type Refusal = { error?: string };

export function useApiKey(options: { baseUrl?: string; fetchJson?: FetchJson } = {}): {
  /** Undefined until the first answer arrives — which is *not* the same as "no key". */
  state: KeyState | undefined;
  error: string | undefined;
  busy: boolean;
  save: (apiKey: string) => Promise<boolean>;
  remove: () => Promise<void>;
} {
  const { baseUrl = DEFAULT_BASE_URL } = options;
  const fetchJson = options.fetchJson ?? credentialedFetch;
  const [state, setState] = useState<KeyState | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: see the note in useProjectFiles
  useEffect(() => {
    let live = true;

    void (async () => {
      try {
        const response = await fetchJson(`${baseUrl}/account/api-key`);
        if (!response.ok) return;

        const parsed = KeyStatusSchema.safeParse(await response.json());
        if (live && parsed.success) setState(toState(parsed.data));
      } catch {
        // Left undefined, which the welcome step reads as "do not decide yet". Guessing "no
        // key" here would show the paste form to somebody who already has one saved.
      }
    })();

    return () => {
      live = false;
    };
    // `fetchJson` is deliberately absent, for the reason `useProjectFiles` documents: an inline
    // arrow is a new function every render, and depending on it would refetch forever.
  }, [baseUrl]);

  const send = useCallback(
    async (init: RequestInit): Promise<boolean> => {
      setBusy(true);
      setError(undefined);

      try {
        const response = await fetchJson(`${baseUrl}/account/api-key`, init);
        const body: unknown = await response.json().catch(() => undefined);

        if (!response.ok) {
          // The server's own sentence when there is one: it is the only thing that can say
          // *why* a key was refused, and "that did not work" would throw that away.
          setError((body as Refusal | undefined)?.error ?? UNKNOWN);
          return false;
        }

        const parsed = KeyStatusSchema.safeParse(body);
        if (parsed.success) setState(toState(parsed.data));
        return true;
      } catch {
        setError(UNREACHABLE);
        return false;
      } finally {
        // In a `finally` rather than on each path: a save that threw would otherwise leave the
        // button on "Checking…" for as long as the page stayed open, which is the exact failure
        // the sign-in page already documents.
        setBusy(false);
      }
    },
    [baseUrl, fetchJson],
  );

  return {
    state,
    error,
    busy,
    save: (apiKey: string) =>
      send({
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey }),
      }),
    remove: async () => {
      await send({ method: "DELETE" });
    },
  };
}

/** The wire shape has optional fields; the form's takes one of two definite shapes. */
function toState(status: {
  configured: boolean;
  platform?: string | undefined;
  hint?: string | undefined;
}): KeyState {
  if (!status.configured || status.platform === undefined || status.hint === undefined) {
    return { configured: false };
  }
  return {
    configured: true,
    platform: status.platform === "anthropic" ? "anthropic" : "openrouter",
    hint: status.hint,
  };
}
