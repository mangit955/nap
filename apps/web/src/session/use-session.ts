"use client";

/**
 * Having a session to talk in.
 *
 * The browser arrives with nothing and can do nothing until it has a session id — the socket,
 * the file tree and every turn are all addressed by one. So this runs before anything else:
 * read the id this browser used last time, and if there is none, ask the server for one.
 *
 * **It is kept in `localStorage` so a reload continues the same conversation.** Without that,
 * every refresh would open an empty project and abandon the transcript the user was reading.
 * This is also the last piece of the temporary `NEXT_PUBLIC_DEV_SESSION_ID` arrangement being
 * dismantled: sessions are now created by the app rather than pasted into an env file.
 *
 * A stored value is validated rather than trusted. Anything on the machine can write to
 * `localStorage`, and a junk id would be sent to the API forever — every request a 400, with
 * no way for the user to get out of it short of knowing what a dev console is.
 *
 * Project CRUD replaces this with a real project picker; what stays is the shape — one id,
 * resolved once, handed down to every pane.
 */

import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import type { FetchJson } from "../files/use-project-files.ts";

export const SESSION_STORAGE_KEY = "nap.sessionId";

const CreatedSessionSchema = z.object({ sessionId: z.uuid(), projectId: z.uuid() });

export type SessionStatus = "creating" | "ready" | "error";

export type Session = {
  sessionId: string | undefined;
  status: SessionStatus;
};

const DEFAULT_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export function useSession(options: { baseUrl?: string; fetchJson?: FetchJson } = {}): Session {
  const { baseUrl = DEFAULT_BASE_URL } = options;
  const fetchJson = options.fetchJson ?? ((url, init) => fetch(url, init));

  // Read during the first render rather than in an effect: a session this browser already has
  // is not something to show a loading state for, and the panes below can connect immediately.
  const [sessionId, setSessionId] = useState<string | undefined>(storedSession);
  const [status, setStatus] = useState<SessionStatus>(
    sessionId === undefined ? "creating" : "ready",
  );

  // React mounts, unmounts and remounts every effect in development. An unguarded create call
  // would leave an orphan project in the database on every page load.
  const requested = useRef(false);

  // `fetchJson` is deliberately not a dependency; see the note in `useProjectFiles`.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (sessionId !== undefined || requested.current) return;
    requested.current = true;

    void (async () => {
      try {
        const response = await fetchJson(`${baseUrl}/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        });
        if (!response.ok) throw new Error(`the server answered ${response.status}`);

        const created = CreatedSessionSchema.parse(await response.json());
        localStorage.setItem(SESSION_STORAGE_KEY, created.sessionId);
        setSessionId(created.sessionId);
        setStatus("ready");
      } catch {
        // Reported rather than retried: whatever is wrong — no database, no server — will not
        // be fixed by asking again immediately, and the page says so instead of spinning.
        setStatus("error");
      }
    })();
  }, [sessionId, baseUrl]);

  return { sessionId, status };
}

function storedSession(): string | undefined {
  // Server-rendered first, where there is no storage at all — and a browser can have it
  // disabled entirely, which throws rather than returning null.
  try {
    const stored = localStorage.getItem(SESSION_STORAGE_KEY);
    return stored !== null && z.uuid().safeParse(stored).success ? stored : undefined;
  } catch {
    return undefined;
  }
}
