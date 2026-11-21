"use client";

/**
 * Eases in whatever a demo gained since its last beat: a transcript row, a pane, a panel.
 *
 * The demos are the product's own components, which swap their contents without transitions, as
 * an app should. On a page that is meant to be watched that reads as a cut, so this finds what is
 * new under `ref` after each beat and fades it up a few pixels, one after another. Nothing that
 * was already there moves again.
 *
 * **What counts** is each row of a transcript (`[role="log"] > div`, see `chat-transcript.tsx`)
 * and anything marked `data-arrive`. Rows are found by structure because they belong to the
 * product, which knows nothing of the landing page.
 *
 * **`from`** says what the first beat is. `"shown"`: it is already on screen (the hero, drawn at
 * load), so it is only recorded. `"hidden"`: the section is waiting to be scrolled to, so beat 0
 * records nothing and everything arrives at the first beat after it.
 *
 * The Web Animations API rather than classes, so an element animates once, when it arrives, and
 * nothing in a stylesheet can replay it. With `fill: "backwards"` an element waiting for its turn
 * is held invisible, so a row never shows, vanishes and fades back. Under reduced motion nothing
 * animates and everything is simply there.
 */

import { type RefObject, useLayoutEffect, useRef } from "react";

export const ARRIVING = '[role="log"] > div, [data-arrive]';
/** Short and decelerating: arriving, not bouncing. */
const EASE = "cubic-bezier(0.22, 1, 0.36, 1)";
const DURATION_MS = 460;
const STAGGER_MS = 90;

export function useArrivals(
  ref: RefObject<HTMLElement | null>,
  beat: number,
  from: "shown" | "hidden",
): void {
  const seen = useRef<WeakSet<Element>>(new WeakSet());
  useLayoutEffect(() => {
    const root = ref.current;
    if (root === null) return;
    const found = [...root.querySelectorAll(ARRIVING)];
    if (beat === 0) {
      if (from === "shown") for (const element of found) seen.current.add(element);
      return;
    }
    const fresh = found.filter((element) => !seen.current.has(element));
    for (const element of fresh) seen.current.add(element);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    fresh.forEach((element, index) => {
      element.animate?.(
        [
          { opacity: 0, transform: "translateY(8px)" },
          { opacity: 1, transform: "none" },
        ],
        { duration: DURATION_MS, delay: index * STAGGER_MS, easing: EASE, fill: "backwards" },
      );
    });
  }, [ref, beat, from]);
}
