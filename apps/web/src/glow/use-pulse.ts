"use client";

/**
 * When the light runs, and what colour it is when it does.
 *
 * The pulse is a **one-shot**, not a loop: it rises, holds briefly and dies, and as it fades
 * the wedge tightens at its head and blooms at its tail. A looping rotation instead reads as a
 * spinning wheel, which is a progress bar — this is meant to read as something noticing you.
 *
 * Retriggering is the fiddly part. The animation restarts because `data-playing` goes false
 * and then true, and those two writes have to land in **different frames**: in one frame the
 * browser coalesces them and nothing restarts at all.
 *
 * A new palette is rolled before each pulse, so consecutive pulses are different colours and
 * the light spilling into the page drifts rather than throbbing on one hue.
 *
 * It stops when nobody is looking — offscreen, or a hidden tab — because ten masked layers
 * animating a registered custom property is not free, and a background tab is the one place
 * that cost buys nothing.
 *
 * Under reduced motion the light never lights. The loop still runs its timers so the rest of
 * the page behaves identically; only the attribute that drives the animation is withheld.
 */

import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { rollPalette } from "./palette.ts";

export function useReducedMotion(): { reduced: boolean; reducedRef: RefObject<boolean> } {
  const [reduced, setReduced] = useState(false);
  const reducedRef = useRef(false);

  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => {
      reducedRef.current = query.matches;
      setReduced(query.matches);
    };
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);

  return { reduced, reducedRef };
}

export type PulseOptions = {
  ref: RefObject<HTMLElement | null>;
  /** How long one pulse takes. Must match the keyframes in `globals.css`. */
  pulseMs?: number;
  /** Dark time between pulses. */
  gapMs?: number;
};

export function useAiPulse({ ref, pulseMs = 1600, gapMs = 2600 }: PulseOptions): {
  /** Fires a pulse now — what the send button calls, so pressing it is answered by light. */
  pulse: () => void;
} {
  const { reducedRef } = useReducedMotion();
  const timer = useRef<number | null>(null);
  const aliveRef = useRef(false);

  const play = useCallback(() => {
    const element = ref.current;
    if (element === null || reducedRef.current) return;

    rollPalette(element);
    element.dataset.playing = "false";
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (aliveRef.current) element.dataset.playing = "true";
      });
    });
  }, [ref, reducedRef]);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;

    aliveRef.current = true;
    let onScreen = false;
    let hidden = document.hidden;

    const clear = () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      timer.current = null;
    };

    const beat = () => {
      if (!aliveRef.current) return;
      play();
      timer.current = window.setTimeout(beat, pulseMs + gapMs);
    };

    const sync = () => {
      if (!aliveRef.current) return;
      if (onScreen && !hidden) {
        if (timer.current === null) beat();
      } else {
        clear();
        element.dataset.playing = "false";
      }
    };

    // A little margin, so the first pulse has happened by the time the box is properly on
    // screen rather than starting as the user watches it arrive.
    const observer = new IntersectionObserver(
      (entries) => {
        onScreen = entries.some((entry) => entry.isIntersecting);
        sync();
      },
      { rootMargin: "200px" },
    );
    observer.observe(element);

    const onVisibility = () => {
      hidden = document.hidden;
      sync();
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      aliveRef.current = false;
      clear();
      observer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [ref, play, pulseMs, gapMs]);

  return { pulse: play };
}
