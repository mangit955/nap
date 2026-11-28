"use client";

import type { SessionSummary } from "@nap/shared/session-navigation";
import { useEffect, useRef } from "react";
import { showToast } from "../ui/toasts.ts";
import { finishedInBackground } from "./session-rows.ts";

/**
 * The last list compared, for the whole tab rather than one mount. The dashboard and each
 * project's workspace hold separate lists, and opening a session from the dashboard swaps one
 * for the other: a turn finishing before the workspace's first list arrived would otherwise be on
 * no list "before", and pass unannounced.
 */
let lastCompared: readonly SessionSummary[] | undefined;

/**
 * How long a session still counts as watched after the reader leaves it. A turn can finish on
 * screen and the reader move on before the list showing it arrives — a read takes well under a
 * second — so the session they just left is not news for a moment. A turn that really does finish
 * this soon after leaving gets no toast, only the row's dot.
 */
export const LEFT_GRACE_MS = 2000;

/**
 * Says so when a session the reader is not looking at finishes its turn: T3's "Session finished"
 * toast, whose Open goes there. Read from the session list the sidebar already holds — a finished
 * turn moves a row's `turnFinishedAt`, and the list is read again whenever the server says it
 * changed — so it needs no event of its own. Which rows count is `finishedInBackground`'s rule.
 *
 * `ready` is false until the first list has loaded: the empty list before it is not "nothing",
 * and comparing against it would hide every finish that lands meanwhile.
 *
 * The row keeps its unread dot until it is opened; the toast is only the moment it happened.
 */
export function useFinishedToasts(
  projects: readonly SessionSummary[],
  ready: boolean,
  openProjectId: string | undefined,
  open: (projectId: string) => void,
): void {
  // When each session the reader has left was last open, by this tab's clock.
  const leftAt = useRef(new Map<string, number>());
  const wasOpen = useRef(openProjectId);
  // The newest list and `open`, for a toast's button pressed after both have moved on.
  const latest = useRef({ projects, open });
  latest.current = { projects, open };
  useEffect(() => {
    const now = Date.now();
    if (wasOpen.current !== undefined && wasOpen.current !== openProjectId)
      leftAt.current.set(wasOpen.current, now);
    wasOpen.current = openProjectId;
    if (!ready || projects === lastCompared) return;
    const viewed = new Set(openProjectId === undefined ? [] : [openProjectId]);
    for (const [projectId, at] of leftAt.current) {
      if (now - at < LEFT_GRACE_MS) viewed.add(projectId);
      else leftAt.current.delete(projectId);
    }
    const finished = finishedInBackground(lastCompared, projects, viewed, now);
    lastCompared = projects;
    for (const { projectId, name } of finished)
      showToast({
        title: "Session finished",
        description: name,
        tone: "finished",
        action: {
          label: "Open",
          // Deleted or archived while the toast was up: there is nowhere to go.
          onClick: () => {
            const { projects: now, open: go } = latest.current;
            if (now.some((row) => row.projectId === projectId)) go(projectId);
          },
        },
      });
  }, [projects, ready, openProjectId]);
}
