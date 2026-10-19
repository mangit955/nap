"use client";

/**
 * Working the card out once, at the moment somebody comes back.
 *
 * The rule is in `unseen-summary.ts`, where it is checkable without a browser. What genuinely needs
 * one is *when* it is asked — and asking it on every frame would be wrong in a way that is easy
 * to miss.
 *
 * **The seam does not move while somebody reads.** That is deliberate (`use-seen-cursor.ts`): a
 * marker that slid down to the newest event would never mark anything. But it means every event
 * arriving now is, arithmetically, below the cursor — so a card recomputed continuously would
 * announce "while you were away" about the turn its reader is sitting there watching finish.
 * The card is a fact about an *interval that has ended*, so it is worked out from the log as it
 * stood when reading resumed, and then held still.
 *
 * **So it re-asks when reading resumes, and "resumes" is an event rather than a value.** The
 * cursor is re-read on mount and on returning to a hidden tab or chat pane, when there may be an
 * absence to describe. A new *seam* is not a reliable signal of one: a tab that
 * was already up to date when it was hidden comes back to a cursor holding the same number it
 * held before, React bails out of the identical state, and an effect watching only that value
 * never runs — which is silence in exactly the case this whole feature exists for. So the
 * visibility transition and chat activity are dependencies in their own right.
 *
 * On document visibility changes, this hook and `useSeenCursor` update in one batch, so the
 * recompute sees the seam as it has just been re-read. Chat reopening is an explicit dependency
 * too, even when re-reading the cursor leaves that seam unchanged.
 *
 * It waits for the replay, because events arrive one at a time and `ready` comes last — a card
 * worked out on the first frame is a card worked out over an empty log, and freezing that would
 * be silence about a session where something plainly happened.
 */

import type { StoredEvent } from "@nap/shared/ports/event-store";
import { useEffect, useRef, useState } from "react";
import { type UnseenSummary, unseenSummary } from "./unseen-summary.ts";

export function useUnseenCard(
  events: readonly StoredEvent[],
  /** Where this browser's reading stopped, from `useSeenCursor`. */
  seen: number | undefined,
  /** Whether the server has said it sent everything it had. See `useEventStream`. */
  replayed: boolean,
  /** The pane stays mounted while hidden; reopening it starts a new reading interval. */
  active = true,
): { card: UnseenSummary | null; dismiss: () => void } {
  const [card, setCard] = useState<UnseenSummary | null>(null);
  /** How many times this browser has come back to the tab. A counter, because only the *change*
   * is read — see the header for why the seam's value cannot serve as that signal. */
  const [resumed, setResumed] = useState(0);
  // Read when reading resumes, never depended on. The log grows constantly and this is a
  // question about the moment, not about the log.
  const eventsRef = useRef(events);
  eventsRef.current = events;

  useEffect(() => {
    const onChange = () => {
      if (document.visibilityState === "visible") setResumed((count) => count + 1);
    };

    document.addEventListener("visibilitychange", onChange);
    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  // The events are deliberately not a dependency — which is why they are read through a ref
  // rather than closed over, and why no linter complains about their absence from the list. An
  // effect that re-ran on every event would turn a summary of an absence into a running
  // commentary. See the header.
  //
  // `resumed` is a *trigger* rather than a value the effect reads — the same shape
  // `use-stick-to-bottom.ts` uses for its signal — so the rule that wants it removed would
  // leave a hook that never re-asks on a return where the cursor did not move.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (!active || !replayed) return;
    setCard(unseenSummary(eventsRef.current, seen));
  }, [seen, replayed, resumed, active]);

  return { card, dismiss: () => setCard(null) };
}
