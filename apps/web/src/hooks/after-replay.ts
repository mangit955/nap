"use client";

/**
 * The newest notice of a kind, as a refresh key that does not move for history.
 *
 * The workspace re-reads the project record and its GitHub state when certain events arrive, by
 * passing the newest such event's `seq` as a refresh key. Before the replay that key is 0; the
 * replay lands as one batch, and the key jumped straight to the newest notice in the *history* —
 * so every open read both a second time, about a second after the first, for events the first
 * reads already reflected. Measured on production as a repeat `GET /projects/:id` and
 * `GET /projects/:id/github` on every switch.
 *
 * **Not every replayed notice is history, though.** The first reads go out at the click; the
 * socket subscribes a round trip later, after its ticket. A notice stored in between is in the
 * replay and in neither read. Which side of the read a notice fell on is not knowable here — the
 * record does not say which log position it reflects — so a replayed notice counts as already
 * read only once it is `SETTLED_MS` old by the browser's clock. A recent one is read again, as
 * every one used to be. The window is wide so a browser clock a little off the server's still
 * errs towards reading again; one far ahead would make a notice from that gap look settled, and
 * the title or the pull-request panel would wait for the next notice, or for focus.
 *
 * Per session: the stream's `replayed` names the session it is true for.
 */

import type { StoredEvent } from "@nap/shared/ports/event-store";
import { useState } from "react";

/** How old a replayed notice must be before the first reads are trusted to reflect it. */
export const SETTLED_MS = 60_000;

export function useAfterReplay(
  events: readonly StoredEvent[],
  isNotice: (event: StoredEvent) => boolean,
  replayed: boolean,
  sessionId: string | undefined,
  now: () => number = Date.now,
): number {
  const newest = events.findLast(isNotice)?.seq ?? 0;
  const [baseline, setBaseline] = useState<{ sessionId: string; seq: number }>();
  // Set during render rather than in an effect, so the render that first sees the replay already
  // answers from it: an effect would commit one frame with the jump in it, which is the read this
  // avoids. It sets at most once per session, so it cannot loop.
  if (replayed && sessionId !== undefined && baseline?.sessionId !== sessionId) {
    const settledBy = now() - SETTLED_MS;
    const settled = events.findLast(
      (event) => isNotice(event) && Date.parse(event.createdAt) <= settledBy,
    );
    setBaseline({ sessionId, seq: settled?.seq ?? 0 });
  }
  if (!replayed || baseline === undefined || baseline.sessionId !== sessionId) return 0;
  return newest > baseline.seq ? newest : 0;
}
