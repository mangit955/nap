"use client";

import { authClient } from "../auth/client.ts";
import { AppShell } from "../components/app-shell.tsx";
import type { FetchJson } from "../files/use-project-files.ts";
import type { CreateSocket } from "../hooks/use-event-stream.ts";

/**
 * One project's workspace, inside the frame the `/p` layout draws.
 *
 * **Keyed by project, and that key is the reset.** Switching projects is a client-side
 * navigation, so nothing about the browser forgets the last project: the shell's state, its
 * subscription and its fetches in flight all belong to whichever project they started for, and
 * a new key is what throws them away — the old socket closed, a late answer landing in an
 * unmounted tree — before the next project draws anything. Next remounts the page on a new
 * segment too, but that is its rendering detail rather than a promise, and it changes under
 * cache components; this holds either way.
 *
 * `fetchJson` and `createSocket` pass through to the shell, for the reason the shell takes them.
 * Production passes neither.
 */
export function LiveWorkspace({
  projectId,
  fetchJson,
  createSocket,
}: {
  projectId: string;
  fetchJson?: FetchJson | undefined;
  createSocket?: CreateSocket | undefined;
}) {
  // The frame shows nothing below it until there is a session; this only reads whose it is.
  const { data } = authClient.useSession();
  if (!data) return null;
  return (
    <AppShell
      key={projectId}
      projectId={projectId}
      ownerId={data.user.id}
      fetchJson={fetchJson}
      createSocket={createSocket}
    />
  );
}
