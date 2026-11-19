"use client";

/**
 * Scrolling the conversation: following a running turn, and holding a just-sent message at the top.
 *
 * What to do is decided in `transcript-scroll.ts`, which reads numbers and says where the box goes.
 * This half takes those numbers off the DOM and applies the answer.
 *
 * A layout effect rather than an ordinary one: it runs between React's commit and the browser's
 * paint, so the box is never seen at the old offset. In a passive effect the wrong frame paints
 * first and the transcript visibly jumps.
 *
 * Prompts are found by `data-turn-prompt`, on the bubble of every message the user wrote and of the
 * optimistic one standing in for it. Positions come from `getBoundingClientRect` against the box,
 * not `offsetTop`, so a positioned element somewhere between a bubble and the box cannot move the
 * origin they are measured from.
 */

import { type RefObject, useLayoutEffect, useRef } from "react";
import { FRESH, leftAt, planScroll, type ScrollMemory } from "./transcript-scroll.ts";

/** What a prompt bubble carries so the box can find it. */
const TURN_PROMPT = "[data-turn-prompt]";

export type TranscriptScroll<T extends HTMLElement> = {
  /** The scrolling box. */
  scroller: RefObject<T | null>;
  /** An empty element after everything in the box, whose height is the end space. */
  room: RefObject<HTMLDivElement | null>;
};

export function useTranscriptScroll<T extends HTMLElement>({
  signal,
  sending,
  steering,
  working,
}: {
  /**
   * What "there is something new to see" means to the caller — a count, or several joined into
   * one string. **One value rather than a dependency array**, so the effect's own list stays a
   * literal: a caller passing `[a, b]` builds a new array every render, which no linter can
   * verify and which would run this on every frame.
   */
  signal: unknown;
  /** A message from this tab that opens a turn is on its way. See `ScrollReading`. */
  sending: boolean;
  /** A message from this tab sent into the running turn is on its way. */
  steering: boolean;
  /** The newest response has started working. */
  working: boolean;
}): TranscriptScroll<T> {
  const scroller = useRef<T>(null);
  const room = useRef<HTMLDivElement>(null);
  const memory = useRef<ScrollMemory>(FRESH);

  // The signal is a *trigger*, not a value the effect reads — it is the caller's way of saying
  // "there is new content below". So it is legitimately an unused dependency, and the rule that
  // wants it removed would leave an effect that never runs again after mount.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useLayoutEffect(() => {
    const box = scroller.current;
    if (box === null) return;

    const origin = box.getBoundingClientRect().top - box.scrollTop;
    const promptTops = Array.from(
      box.querySelectorAll(TURN_PROMPT),
      (prompt) => prompt.getBoundingClientRect().top - origin,
    );
    const spacer = room.current;
    // Where the content ends is where the end space begins, plus the padding that keeps the last
    // line clear of the composer. `scrollHeight` cannot say it: it is never less than the box.
    const contentEnd =
      spacer === null
        ? box.scrollHeight
        : spacer.getBoundingClientRect().top -
          origin +
          (Number.parseFloat(getComputedStyle(box).paddingBottom) || 0);

    const plan = planScroll(memory.current, {
      promptTops,
      contentEnd,
      clientHeight: box.clientHeight,
      scrollTop: box.scrollTop,
      bottom: Math.max(0, box.scrollHeight - box.clientHeight),
      sending,
      steering,
      working,
    });

    if (spacer !== null) spacer.style.height = `${plan.space}px`;
    // Read after the end space is set, which lays the box out again: the bottom moved with it.
    const bottom = Math.max(0, box.scrollHeight - box.clientHeight);
    if (plan.scroll === "bottom") box.scrollTop = bottom;
    else if (plan.scroll !== undefined) box.scrollTop = Math.min(bottom, plan.scroll);

    memory.current = leftAt(plan.memory, box.scrollTop, box.scrollHeight);
  }, [signal, sending, steering, working]);

  return { scroller, room };
}
