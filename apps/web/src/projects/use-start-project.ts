"use client";

/**
 * Turning a sentence into a project, from wherever it was typed.
 *
 * Two places now do this — the landing page's hero and the dashboard's composer — and both want
 * the same three beats: create a project, write the prompt down where the workspace will find
 * it, and go there. The turn itself is started in the workspace rather than here: the session to
 * send it to is the project's, and neither of these pages has opened the socket that would tell
 * it when that session exists.
 *
 * The project is created with a POST of its own rather than through `useProjects`, which also
 * loads the list on mount and reloads it after every action. The pages that start a project this
 * way either have their own list already or have none to load.
 *
 * `fetch` comes in through an argument, exactly as it does in `useProjects`, so every branch —
 * including a refusal — is testable without a network.
 */

import { CreatedProjectSchema } from "@nap/shared/projects-protocol";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { credentialedFetch } from "../api/credentialed-fetch.ts";
import { stashFirstPrompt } from "../chat/first-prompt.ts";
import type { FetchJson } from "../files/use-project-files.ts";

const DEFAULT_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

/** When the server refused and said nothing usable about why. */
const UNKNOWN = "Could not start a project. Try again in a moment.";
const UNREACHABLE = "Could not reach the server. Check your connection, then try again.";

export type StartProject = {
  /** Set from the press until the navigation, so the box cannot be sent twice. */
  busy: boolean;
  error: string | undefined;
  start: (message: string) => Promise<void>;
};

export function useStartProject(
  options: { baseUrl?: string; fetchJson?: FetchJson } = {},
): StartProject {
  const { baseUrl = DEFAULT_BASE_URL } = options;
  const fetchJson = options.fetchJson ?? credentialedFetch;
  const router = useRouter();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  // `fetchJson` is deliberately not a dependency; see the note in `useProjectFiles`.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  const start = useCallback(
    async (message: string): Promise<void> => {
      const prompt = message.trim();
      if (prompt === "") return;

      setBusy(true);
      setError(undefined);

      // The three failures are told apart rather than funnelled through one `catch`, because
      // they are three different sentences: a network that is not there, a server that refused
      // and said why, and a reply we could not read. A single handler reporting the thrown
      // message would show a browser's "Failed to fetch" to somebody who typed a prompt.
      let response: Response;
      try {
        response = await fetchJson(`${baseUrl}/projects`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        });
      } catch {
        setBusy(false);
        setError(UNREACHABLE);
        return;
      }

      if (!response.ok) {
        setBusy(false);
        setError(await reason(response));
        return;
      }

      try {
        const created = CreatedProjectSchema.parse(await response.json());
        stashFirstPrompt(created.projectId, prompt);

        // Deliberately not `setBusy(false)`: the page is on its way out, and re-enabling the
        // control first invites a second project from a second press during the navigation.
        router.push(`/p/${created.projectId}`);
      } catch {
        setBusy(false);
        setError(UNKNOWN);
      }
    },
    [baseUrl, router],
  );

  return { busy, error, start };
}

/** The server's own sentence where it has one — it knows things a status code does not. */
async function reason(response: Response): Promise<string> {
  try {
    const body: unknown = await response.json();
    const message = (body as { error?: unknown } | null)?.error;
    return typeof message === "string" && message !== "" ? message : UNKNOWN;
  } catch {
    return UNKNOWN;
  }
}
