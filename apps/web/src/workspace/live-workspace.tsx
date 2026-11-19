"use client";

import { authClient } from "../auth/client.ts";
import { AppShell } from "../components/app-shell.tsx";
import type { FetchJson } from "../files/use-project-files.ts";
import type { CreateSocket } from "../hooks/use-event-stream.ts";
import { useOpenProjectId } from "./open-project.ts";

/**
 * One project's workspace, inside the frame the `/p` layout draws.
 *
 * The project is the pathname's, not the route's params: a sidebar switch pushes a new address
 * without re-rendering the page, so params would still name the first project opened. See
 * `open-project.ts`.
 *
 * **Keyed by project, and that key is the reset.** Switching projects is a client-side
 * navigation, so nothing about the browser forgets the last project: the shell's state, its
 * subscription and its fetches in flight all belong to whichever project they started for, and
 * a new key is what throws them away — the old socket closed, a late answer landing in an
 * unmounted tree — before the next project draws anything. A sidebar switch does not change the
 * page's segment at all, so this key is the only reset there is. What survives a switch on
 * purpose is the log this tab saw, so coming back draws at once — see `remembered-logs.ts`.
 *
 * `fetchJson` and `createSocket` pass through to the shell, for the reason the shell takes them.
 * Production passes neither.
 */
export function LiveWorkspace({
  fetchJson,
  createSocket,
}: {
  fetchJson?: FetchJson | undefined;
  createSocket?: CreateSocket | undefined;
}) {
  // The frame shows nothing below it until there is a session; this only reads whose it is.
  const { data } = authClient.useSession();
  const projectId = useOpenProjectId();
  if (!data || projectId === undefined) return null;
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
