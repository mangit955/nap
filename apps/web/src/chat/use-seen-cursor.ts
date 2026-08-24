"use client";

/**
 * Keeping the seen cursor up to date, and holding still the place it stood when reading stopped.
 *
 * The arithmetic and the storage are in `unseen.ts`, where they are checkable without a browser.
 * What is left here is the part that genuinely needs one: reading the cursor after mount, writing
 * it forward as events are displayed, and noticing that the tab stopped being looked at.
 *
 * **Two numbers, and only one of them moves.** The cursor advances to whatever has been displayed,
 * so closing the tab at any moment records the right thing. The *seam* is a copy of where that
 * cursor stood when this browser last stopped watching, and it deliberately does not move while
 * the reader watches the log grow — a marker that slid down to the newest event would be a marker
 * that never marks anything.
 *
 * **Displayed means displayed.** A background tab keeps its socket open and the worker keeps
 * going, so events arrive at a page nobody is looking at; counting those would make "you missed
 * this" a thing that never fires for the one case it exists for. So the cursor advances only while
 * the document is visible, and coming back re-reads it — which is what makes a tab left open
 * behave like a tab that was closed and reopened.
 *
 * Read after mount, never during render: `localStorage` does not exist on the server, and a first
 * render that reached for it would either crash or produce markup the client disagrees with.
 */

import { useEffect, useState } from "react";
import { readSeen, writeSeen } from "./unseen.ts";

/**
 * The seam: the highest sequence this browser had displayed when it last stopped watching, or
 * `undefined` when there is no such place — a session it has never opened, or no session yet.
 */
export function useSeenCursor(
  sessionId: string | undefined,
  /** The highest sequence received, from `useEventStream`. Per-connection; this one is not. */
  lastSeq: number,
): number | undefined {
  const [seam, setSeam] = useState<number | undefined>(undefined);
  const [watching, setWatching] = useState(true);

  // Before anything is written, and that ordering is the whole hook: effects run in declaration
  // order within a commit, so the cursor is read where it was left before this visit advances it.
  useEffect(() => {
    if (sessionId === undefined) {
      setSeam(undefined);
      return;
    }

    setSeam(readSeen(globalThis.localStorage, sessionId));
    setWatching(document.visibilityState === "visible");
  }, [sessionId]);

  useEffect(() => {
    if (sessionId === undefined) return;

    const onChange = () => {
      if (document.visibilityState !== "visible") {
        setWatching(false);
        return;
      }
      // The cursor stopped advancing when the tab was hidden, so where it stands now is exactly
      // where this browser left off. Read before watching resumes, or the write below overtakes
      // it and the seam lands on the newest event.
      setSeam(readSeen(globalThis.localStorage, sessionId));
      setWatching(true);
    };

    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, [sessionId]);

  useEffect(() => {
    if (sessionId === undefined || !watching) return;
    // **Nothing received is not a cursor of zero.** A connection opens at zero and climbs, and
    // writing that first zero down would turn "this browser has never opened the session" into
    // "it has seen nothing of it" — which draws a seam above the first thing anybody ever said.
    if (lastSeq === 0) return;

    writeSeen(globalThis.localStorage, sessionId, lastSeq);
  }, [sessionId, lastSeq, watching]);

  return seam;
}
