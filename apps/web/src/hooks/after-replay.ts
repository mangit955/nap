"use client";

/**
 * A log position as a revision that counts only what happened after the log was replayed.
 *
 * The workspace re-reads the project record and its GitHub state when certain events arrive, by
 * passing the newest such event's `seq` as a refresh key. Before the replay that key is 0; the
 * replay lands as one batch, and the key jumped straight to the newest notice in the *history* —
 * so every open read both a second time, about a second after the first, for events the first
 * reads already reflected. Measured on production as a repeat `GET /projects/:id` and
 * `GET /projects/:id/github` on every switch.
 *
 * So the key stays 0 through the replay and moves only for an event newer than the replay's last.
 * Per session, since a different session is a different log.
 */

import { useState } from "react";

export function useAfterReplay(seq: number, replayed: boolean, sessionId: string | undefined) {
  const [baseline, setBaseline] = useState<{ sessionId: string | undefined; seq: number }>();
  // Set during render rather than in an effect, so the render that first sees the replay already
  // answers 0: an effect would commit one frame with the jump in it, which is the read this avoids.
  if (replayed && baseline?.sessionId !== sessionId) setBaseline({ sessionId, seq });
  if (!replayed || baseline === undefined || baseline.sessionId !== sessionId) return 0;
  return seq > baseline.seq ? seq : 0;
}
