"use client";

/**
 * Which models this deployment will run a turn on.
 *
 * Fetched once rather than subscribed to: the allowlist is an environment variable, so it
 * changes when the server restarts and never while a page is open. Asked for once per mount,
 * which is once per project opened.
 *
 * **A failure here is not an error the user is shown.** The picker simply does not appear, and
 * every turn runs on the deployment's default — which is exactly what happened before this
 * control existed. A prominent failure would be telling somebody their app is broken because
 * an optional convenience did not load.
 *
 * `fetch` comes in through an argument, the way `useProjectFiles` and `useEventStream` take
 * theirs, so the tests drive every branch without going near a network.
 */

import { type ModelList, ModelListSchema } from "@nap/shared/models-protocol";
import { useEffect, useState } from "react";
import { credentialedFetch } from "../api/credentialed-fetch.ts";
import type { FetchJson } from "../files/use-project-files.ts";

const DEFAULT_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export function useModels(options: { baseUrl?: string; fetchJson?: FetchJson } = {}): {
  models: ModelList | undefined;
} {
  const { baseUrl = DEFAULT_BASE_URL } = options;
  const fetchJson = options.fetchJson ?? credentialedFetch;
  const [models, setModels] = useState<ModelList | undefined>(undefined);

  // biome-ignore lint/correctness/useExhaustiveDependencies: see the note in useProjectFiles
  useEffect(() => {
    // Guards the effect *re-running* with a request still in flight, the way `useProjectFiles`
    // does — an answer for the last base URL must not land after a new one was asked for. It is
    // not an unmount guard: React has not warned about that since 18, and nothing here could
    // observe the difference. Kept because it is the idiom the sibling hook uses, and cheap.
    let live = true;

    void (async () => {
      try {
        const response = await fetchJson(`${baseUrl}/models`);
        if (!response.ok) return;

        const parsed = ModelListSchema.safeParse(await response.json());
        // Validated rather than trusted: a body of the wrong shape would put an undefined id
        // on a turn, which the route then refuses for naming a model that is not a string.
        if (live && parsed.success) setModels(parsed.data);
      } catch {
        // The picker stays hidden and turns run on the default. Nothing to say.
      }
    })();

    return () => {
      live = false;
    };
    // `fetchJson` is deliberately absent, for the reason `useProjectFiles` documents: an inline
    // arrow is a new function every render, and depending on it would refetch forever.
  }, [baseUrl]);

  return { models };
}
