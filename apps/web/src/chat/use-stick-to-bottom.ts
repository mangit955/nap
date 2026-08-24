"use client";

/**
 * Keeping the newest thing in the transcript on screen.
 *
 * Nothing scrolled this pane before, so a running turn wrote off the bottom of it and the reader
 * had to chase the agent with the wheel. But following unconditionally is the other failure:
 * somebody reading the diff from four tool calls ago gets yanked away every time a build prints a
 * line, which is worse than not following at all.
 *
 * So the rule is *was the reader at the bottom before this arrived*, and the emphasis is on
 * **before**. By the time an effect runs, the new content is already laid out — measuring then
 * would find the reader several hundred pixels adrift and conclude they had scrolled away, when
 * what actually happened is that the floor moved. The previous height is kept in a ref for
 * exactly that comparison.
 *
 * A layout effect rather than an ordinary one: this runs between React's commit and the browser's
 * paint, so the box is never seen at the old offset. In a passive effect the wrong frame paints
 * first and the transcript visibly jumps.
 *
 * **The bottom is not always the right place to open.** A reader coming back to a session that
 * grew while they were gone wants the point where their reading stopped, not the newest event —
 * so a caller may hand over something to open at instead, and the seam in `unseen.ts` is what
 * does. It is a *lookup* rather than an element because the pane mounts before the log has
 * replayed: there is nothing to find on the first pass, and the marker appears a frame or two
 * later.
 */

import { type RefObject, useLayoutEffect, useRef } from "react";

/**
 * How far from the bottom still counts as watching.
 *
 * Exactly pinned is too strict — a trackpad's inertia routinely leaves a box a few pixels short,
 * and a transcript that stopped following after a nudge reads as broken rather than as polite.
 */
const NEAR_BOTTOM = 64;

/**
 * How much of what came before is left visible above whatever the box opens at.
 *
 * A marker pinned to the very top edge reads as the top of the transcript; a line of the last
 * thing the reader had already seen is what makes it read as a place they left off.
 */
const OPEN_MARGIN = 24;

export function useStickToBottom<T extends HTMLElement>(
  /**
   * What "there is something new to see" means to the caller — a count, or several joined into
   * one string. **One value rather than a dependency array**, so the effect's own list stays a
   * literal: a caller passing `[a, b]` builds a new array every render, which no linter can
   * verify and which would run this on every frame.
   */
  signal: unknown,
  /**
   * Where to open, instead of at the bottom — the first time it returns anything, and once only.
   * Absent, or never returning an element, leaves the rule above untouched.
   */
  openAt?: (() => HTMLElement | null | undefined) | undefined,
): RefObject<T | null> {
  const ref = useRef<T>(null);
  /**
   * The scroll height at the end of the last pass, and `undefined` until there has been one.
   * That absence is what marks the first render, which always goes to the bottom whatever the
   * box says: a replayed log opens at its newest event, not at an hour of old tool calls.
   */
  const lastHeight = useRef<number | undefined>(undefined);
  /** Whether the box has already been taken somewhere other than the bottom. Once, per mount. */
  const opened = useRef(false);
  // Read inside an effect that was set up on an earlier render, and a caller writing the lookup
  // inline hands over a new closure every frame — which is fine, since it is never a dependency.
  const openAtRef = useRef(openAt);
  openAtRef.current = openAt;

  // The signal is a *trigger*, not a value the effect reads — it is the caller's way of saying
  // "there is new content below". So it is legitimately an unused dependency, and the rule that
  // wants it removed would leave an effect that never runs again after mount.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useLayoutEffect(() => {
    const box = ref.current;
    if (box === null) return;

    const bottom = Math.max(0, box.scrollHeight - box.clientHeight);
    const previous = lastHeight.current;
    lastHeight.current = box.scrollHeight;

    if (!opened.current) {
      const target = openAtRef.current?.();
      if (target != null) {
        opened.current = true;
        // `offsetTop` is measured against the nearest positioned ancestor, and the scroller is
        // one — it carries `relative` so the working indicator can sit over it. A caller who
        // takes that class off would land this at the wrong offset, silently.
        box.scrollTop = Math.max(0, Math.min(bottom, target.offsetTop - OPEN_MARGIN));
        return;
      }
    }

    // Measured against the height the reader was last looking at, not the one that just
    // appeared. See the header — this is the whole point of the ref.
    const wasWatching =
      previous === undefined || previous - box.scrollTop - box.clientHeight <= NEAR_BOTTOM;

    if (wasWatching) box.scrollTop = bottom;
  }, [signal]);

  return ref;
}
