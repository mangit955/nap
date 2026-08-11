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
  /**
   * Where the colours are written. Custom properties inherit, so a roll onto an ancestor
   * reaches the rim layers *and* whatever else that ancestor contains — which is how the wash
   * behind the box is lit by the same arc rather than by a second palette that would drift out
   * of step with it. Defaults to the box itself.
   */
  paletteRef?: RefObject<HTMLElement | null>;
  /** How long one pulse takes. Must match the keyframes in `globals.css`. */
  pulseMs?: number;
  /**
   * Dark time between pulses. **Derive it from the beats that have to fit inside it** rather
   * than picking a number: if the handover has not finished when the next pulse starts, the
   * light runs a rim that is still moving and whose mask is still stale, which is the exact
   * thing the ordering exists to prevent.
   */
  gapMs?: number;
  /** Called on every beat, so a caller can hang its own timeline off the light. */
  onPulse?: () => void;
};

export function useAiPulse({
  ref,
  paletteRef,
  pulseMs = 1600,
  gapMs = 2600,
  onPulse,
}: PulseOptions): {
  /** Fires a pulse now — what the send button calls, so pressing it is answered by light. */
  pulse: () => void;
} {
  const { reducedRef } = useReducedMotion();
  const timer = useRef<number | null>(null);
  const aliveRef = useRef(false);

  // In a ref so a caller can pass an inline closure without restarting the loop on every
  // render — which would reset the interval and, at worst, never let a beat complete.
  const onPulseRef = useRef(onPulse);
  onPulseRef.current = onPulse;

  const play = useCallback(() => {
    const element = ref.current;
    if (element === null) return;

    // The colours are rolled *before* the animation restarts, so the pulse that lights the rim
    // and the wash that follows it are the same arc rather than one lagging a beat behind.
    //
    // This happens under reduced motion too, and deliberately: the wash crossfading over a
    // second and a quarter is a colour change, not travel, and freezing it instead would leave
    // that reader looking at a permanently grey page. What reduced motion withholds is the
    // light *running the rim*, which is the part that moves.
    rollPalette(paletteRef?.current ?? element);
    if (reducedRef.current) return;

    element.dataset.playing = "false";
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (aliveRef.current) element.dataset.playing = "true";
      });
    });
  }, [ref, paletteRef, reducedRef]);

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
      onPulseRef.current?.();
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
