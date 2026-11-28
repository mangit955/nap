"use client";

import type { SessionSummary } from "@nap/shared/session-navigation";
import { useEffect, useRef } from "react";
import { showToast } from "../ui/toasts.ts";
import { finishedInBackground } from "./session-rows.ts";

/**
 * Says so when a session the reader is not looking at finishes its turn: T3's "Session finished"
 * toast, whose Open goes there. Read from the session list the sidebar already holds — a finished
 * turn moves a row's `turnFinishedAt`, and the list is read again whenever the server says it
 * changed — so it needs no event of its own. Which rows count is `finishedInBackground`'s rule.
 *
 * The row keeps its unread dot until it is opened; the toast is only the moment it happened.
 */
export function useFinishedToasts(
  projects: readonly SessionSummary[],
  openProjectId: string | undefined,
  open: (projectId: string) => void,
): void {
  const previous = useRef<readonly SessionSummary[] | undefined>(undefined);
  // The newest `open`, so an inline callback neither re-runs the comparison nor goes stale.
  const latestOpen = useRef(open);
  latestOpen.current = open;
  useEffect(() => {
    const before = previous.current;
    previous.current = projects;
    for (const session of finishedInBackground(before, projects, openProjectId))
      showToast({
        title: "Session finished",
        description: session.name,
        tone: "finished",
        action: { label: "Open", onClick: () => latestOpen.current(session.projectId) },
      });
  }, [projects, openProjectId]);
}
