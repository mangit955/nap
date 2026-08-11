"use client";

/**
 * The half of the hero that talks to the server.
 *
 * Sending does two things and then leaves: it creates a project, and it writes the prompt down
 * where the workspace will find it. The turn itself is started there rather than here — the
 * session to send it to is the project's, and this page has not opened the socket that would
 * tell it when that session exists.
 *
 * **A signed-out visitor is not signed in silently and is not run for.** The prompt is kept,
 * they are sent to sign in, and when they come back it is in the box waiting for them to press
 * send. A page that finished the job on their behalf would create a sandbox and spend a model
 * call on a decision they made several minutes and one redirect ago.
 *
 * The project is created with a POST here rather than through `useProjects`, which also loads
 * the list on mount and reloads it after every action: this page has a list of its own
 * underneath, and half the people looking at it are not signed in to have one.
 */

import { CreatedProjectSchema } from "@nap/shared/projects-protocol";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { credentialedFetch } from "../api/credentialed-fetch.ts";
import { stashFirstPrompt, stashPendingPrompt, takePendingPrompt } from "../chat/first-prompt.ts";
import { Hero } from "./hero.tsx";

const DEFAULT_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

/** When the server refused and said nothing usable about why. */
const UNKNOWN = "Could not start a project. Try again in a moment.";
const UNREACHABLE = "Could not reach the server. Check your connection, then try again.";

export function LiveHero({ signedIn }: { signedIn: boolean }) {
  const router = useRouter();
  const [value, setValue] = useState("");
  const [restored, setRestored] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  // In an effect rather than in `useState`'s initialiser: `sessionStorage` does not exist
  // during the server render, and reading it there is a hydration mismatch rather than a crash.
  useEffect(() => {
    const waiting = takePendingPrompt();
    if (waiting === undefined) return;
    setValue(waiting);
    setRestored(true);
  }, []);

  const submit = (message: string) => {
    if (!signedIn) {
      stashPendingPrompt(message);
      router.push("/sign-in");
      return;
    }

    setBusy(true);
    setError(undefined);

    void credentialedFetch(`${DEFAULT_BASE_URL}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    })
      .then(async (response) => {
        if (!response.ok) throw new Error(await reason(response));
        const created = CreatedProjectSchema.parse(await response.json());

        stashFirstPrompt(created.projectId, message);
        // Not `setBusy(false)`: the page is on its way out, and re-enabling the button first
        // invites a second project from a second press during the navigation.
        router.push(`/p/${created.projectId}`);
      })
      .catch((failure: unknown) => {
        setBusy(false);
        setError(failure instanceof Error ? failure.message : UNREACHABLE);
      });
  };

  return (
    <Hero
      value={value}
      busy={busy}
      error={error}
      restored={restored}
      onChange={(next) => {
        setValue(next);
        setRestored(false);
      }}
      onSubmit={submit}
    />
  );
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
