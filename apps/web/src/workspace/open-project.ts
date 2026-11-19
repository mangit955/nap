"use client";

/**
 * Which project the workspace is showing, read from the address bar rather than from the route.
 *
 * The sidebar switches projects with `history.pushState` (see `SessionSidebar`), which Next 16
 * folds into its router: `usePathname` follows the pushed address, but nothing re-renders the page
 * segment with new params, so `params` and `useParams` would go on naming the project the tab
 * first opened. The pathname is the one answer every way in agrees on — a sidebar switch, a
 * router navigation from the dashboard, back and forward, a deep link and a reload. See
 * `node_modules/next/dist/docs/01-app/01-getting-started/04-linking-and-navigating.md`, "Native
 * History API".
 */

import { usePathname } from "next/navigation";

/** The project a `/p/<id>` address names, or `undefined` for any other address. */
export function projectIdOf(pathname: string | null): string | undefined {
  const match = /^\/p\/([^/]+)\/?$/.exec(pathname ?? "");
  // `/p/new` is the workspace before it knows its project; see `workspace-entry.ts`.
  if (match?.[1] === undefined || match[1] === "new") return undefined;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    // A malformed escape names no project; the page would otherwise throw while rendering.
    return undefined;
  }
}

export function useOpenProjectId(): string | undefined {
  return projectIdOf(usePathname());
}
