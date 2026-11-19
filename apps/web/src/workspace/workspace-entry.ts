"use client";

/**
 * Getting from the dashboard into a workspace without waiting on the server for the page.
 *
 * `/p/[projectId]` is a dynamic route, so Next fetches its payload from the server on every
 * navigation to a new address, and nothing the workspace asks for goes out until that answer is
 * in. A new project is worse: its address does not exist until `POST /sessions/start` answers,
 * so the page fetch could only start after it. `/p/new` is the same page at a static address —
 * prefetched once by the dashboard, then entered with no request at all. The workspace there
 * reads which project to show from what is recorded here, and once it knows, writes the
 * project's own address over `/p/new` with `history.replaceState`, which Next folds into its
 * router exactly as it does the sidebar's `pushState` (see `open-project.ts`). Back from the
 * project returns to the dashboard; a reload or a shared link uses the project's own address.
 *
 * What is recorded is the way in, never the project: which project to open, or a start in flight
 * with the prompt it carries. Project records belong to the workspace's own loading.
 *
 * Module state rather than storage: it only ever has to cross one client-side navigation in this
 * tab, and a reload loses the request it describes anyway — the composer's saved draft is what
 * recovers that (see `NewSessionComposer`).
 */

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useSyncExternalStore } from "react";

/** The workspace before it knows its project. Never a project id: those are UUIDs. */
const WORKSPACE_ENTRY = "/p/new";

/**
 * How often, at most, the dashboard asks for the entry page again while somebody is using it.
 * Next keeps a prefetched page for five minutes (`staleTimes.static`) and fetches it again on the
 * press after that; asking again on activity keeps it fresh for whoever is about to press.
 */
export const PREFETCH_EVERY_MS = 60_000;

type Navigator = { push: (href: string) => void };

/**
 * What a start shows while the server is still creating its project: the words only. Its media
 * arrives with the workspace a moment later, and holding a video's frames here would keep them in
 * memory after the start for no picture.
 */
export type StartingPrompt = { text: string };

type Start = {
  kind: "start";
  ownerId: string;
  prompt: StartingPrompt | undefined;
  outcome:
    | { state: "pending" }
    | { state: "started"; projectId: string }
    | { state: "failed"; error: string };
  settled: Promise<void>;
};
type Entry = { kind: "open"; projectId: string } | Start;

let entry: Entry | undefined;
const listeners = new Set<() => void>();

function set(next: Entry | undefined) {
  entry = next;
  for (const listener of listeners) listener();
}

/**
 * Keeps the entry page prefetched while this page is open: once on mount, then again on activity
 * at most every `PREFETCH_EVERY_MS`. A no-op outside a production build, where Next never prefetches.
 */
export function usePrefetchWorkspace(router: { prefetch: (href: string) => void }): void {
  useEffect(() => {
    let last = Date.now();
    router.prefetch(WORKSPACE_ENTRY);
    const refresh = () => {
      if (Date.now() - last < PREFETCH_EVERY_MS) return;
      last = Date.now();
      router.prefetch(WORKSPACE_ENTRY);
    };
    document.addEventListener("pointerover", refresh);
    document.addEventListener("focusin", refresh);
    return () => {
      document.removeEventListener("pointerover", refresh);
      document.removeEventListener("focusin", refresh);
    };
  }, [router]);
}

/** Opens a project that exists, from anywhere outside `/p`. */
export function openProject(router: Navigator, projectId: string): void {
  set({ kind: "open", projectId });
  router.push(WORKSPACE_ENTRY);
}

/** How the code that asked the server for a project reports the answer. */
export type StartHandle = { started: (projectId: string) => void; failed: (error: string) => void };

/**
 * Enters the workspace now, for a project the server is still creating.
 *
 * The caller still owns the request and must call exactly one of the handle's two methods. A
 * failure sends the workspace back to the dashboard, whose composer reads the reason with
 * `settledStart` and finds the prompt in its saved draft.
 */
export function beginStart(
  router: Navigator,
  start: { ownerId: string; prompt: StartingPrompt | undefined },
): StartHandle {
  let settle = () => {};
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const own: Start = { kind: "start", ...start, outcome: { state: "pending" }, settled };
  const finish = (outcome: Start["outcome"]) => {
    // A later start or open has replaced this one; its answer is no longer anybody's to show.
    if (entry === own) set({ ...own, outcome });
    settle();
  };
  set(own);
  router.push(WORKSPACE_ENTRY);
  return {
    started: (projectId) => finish({ state: "started", projectId }),
    failed: (error) => finish({ state: "failed", error }),
  };
}

function startOf(ownerId: string): Start | undefined {
  return entry?.kind === "start" && entry.ownerId === ownerId ? entry : undefined;
}

/**
 * This person's start still waiting on the server, if any — resolved once it is over.
 *
 * The dashboard composer waits on this before restoring its draft: until the start is over, the
 * saved draft is still on its way to being cleared (started) or given back (failed).
 */
export function startInFlight(ownerId: string): Promise<void> | undefined {
  const start = startOf(ownerId);
  return start?.outcome.state === "pending" ? start.settled : undefined;
}

/**
 * Why this person's last start failed, handed out once. Synchronous, so a caller can check that
 * it still wants the answer first: React runs a development effect twice, and a run that took the
 * reason and was then cancelled would leave nothing for the run that draws it.
 */
export function takeStartFailure(ownerId: string): string | undefined {
  const start = startOf(ownerId);
  if (start?.outcome.state !== "failed") return undefined;
  set(undefined);
  return start.outcome.error;
}

/** Forgets any way in; for sign-out and tests. */
export function forgetWorkspaceEntry(): void {
  set(undefined);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * For the workspace, on `/p/new`: the project to show, or the prompt of a start still on its way.
 * Everywhere else it returns nothing and does nothing.
 *
 * Once the project is known its address replaces `/p/new`; a start that failed goes back to the
 * dashboard, and so does `/p/new` with nothing recorded — a reload, or a typed address.
 */
export function useWorkspaceEntry(): { projectId?: string; starting?: StartingPrompt | null } {
  const router = useRouter();
  const onEntry = usePathname() === WORKSPACE_ENTRY;
  const current = useSyncExternalStore(
    subscribe,
    () => entry,
    () => undefined,
  );
  const target =
    !onEntry || current === undefined
      ? undefined
      : current.kind === "open"
        ? current.projectId
        : current.outcome.state === "started"
          ? current.outcome.projectId
          : undefined;
  const away =
    onEntry &&
    (current === undefined || (current.kind === "start" && current.outcome.state === "failed"));

  useEffect(() => {
    if (target === undefined) return;
    // The record stays: Next moves `usePathname` to the new address on its own schedule, and until
    // it does this page is still `/p/new` — where a forgotten record would read as a reload and
    // send the tab back to the dashboard. It is read nowhere else, and the next way in replaces it.
    window.history.replaceState(null, "", `/p/${encodeURIComponent(target)}`);
  }, [target]);
  useEffect(() => {
    if (away) router.replace("/dashboard");
  }, [away, router]);

  if (!onEntry || current === undefined) return {};
  if (target !== undefined) return { projectId: target };
  return current.kind === "start" && current.outcome.state === "pending"
    ? { starting: current.prompt ?? null }
    : {};
}
