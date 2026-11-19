"use client";

/**
 * Which models this deployment will run a turn on.
 *
 * Read once per tab and shared (`account/account-cache.ts`): the allowlist is an environment
 * variable, so it changes when the server restarts and never while a page is open, and what this
 * caller may run changes only with their key, which re-reads it. Opening another project draws the
 * picker at once instead of asking again.
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
import { accountModels, useAccountResource } from "../account/account-cache.ts";
import { credentialedFetch } from "../api/credentialed-fetch.ts";
import type { FetchJson } from "../files/use-project-files.ts";

const DEFAULT_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export function useModels(options: { baseUrl?: string; fetchJson?: FetchJson } = {}): {
  models: ModelList | undefined;
  loading: boolean;
} {
  const { baseUrl = DEFAULT_BASE_URL } = options;
  const fetchJson = options.fetchJson ?? credentialedFetch;
  const { value, loaded } = useAccountResource(accountModels, async () => {
    try {
      const response = await fetchJson(`${baseUrl}/models`);
      if (!response.ok) return undefined;
      // Validated rather than trusted: a body of the wrong shape would put an undefined id on a
      // turn, which the route then refuses for naming a model that is not a string.
      const parsed = ModelListSchema.safeParse(await response.json());
      return parsed.success ? parsed.data : undefined;
    } catch {
      // The picker stays hidden and turns run on the default. Nothing to say.
      return undefined;
    }
  });
  return { models: value, loading: !loaded };
}
