"use client";

/**
 * Plays the hero session once: Nap working, then verifying, then verified.
 *
 * The story is "it worked while you were away", so the beats are the states a person coming back
 * would find, minutes apart, and not a typing demo. Each lasts long enough to read the bar and the
 * plan, and the last one holds.
 *
 * **It starts when somebody can see it.** The hero is usually on screen at load, but a visitor who
 * lands on `/#changelog` and scrolls up should see the run happen rather than its last frame.
 *
 * **It starts at the first beat, not the finish.** The server's HTML is the first frame, so
 * starting at `verified` and rewinding on hydration would flash the result and then take it away.
 *
 * **The verified result is the fallback, never the first beat.** Under reduced motion, and in a
 * browser with no `IntersectionObserver` to say the hero was seen, it goes straight to
 * `verified`: a run that never starts would leave the visitor looking at work half done.
 */

import { type RefObject, useEffect, useRef, useState } from "react";
export type DemoStage = "working" | "verifying" | "verified";

/** When the plan is three steps in, the app is in Preview and the checks are running. */
export const VERIFYING_AFTER_MS = 2400;
/** When the checks have passed and the session is done. */
export const VERIFIED_AFTER_MS = 5000;
/** Enough of the window showing that the run is not playing to the top of the fold. */
const THRESHOLD = 0.35;

export function useDemoStage<T extends HTMLElement>(): {
  ref: RefObject<T | null>;
  stage: DemoStage;
} {
  const ref = useRef<T>(null);
  const [stage, setStage] = useState<DemoStage>("working");

  useEffect(() => {
    const element = ref.current;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (motion.matches || typeof IntersectionObserver !== "function" || element === null) {
      setStage("verified");
      return;
    }
    const timers: ReturnType<typeof setTimeout>[] = [];
    // Set once the run may no longer start. An observer can still deliver an entry it queued
    // before `disconnect`, so the callback asks this rather than trusting the disconnect.
    let stopped = false;
    // Turning reduced motion on mid-visit ends the run where it would have finished.
    const still = (event: MediaQueryListEvent) => {
      if (!event.matches) return;
      stopped = true;
      observer.disconnect();
      for (const timer of timers) clearTimeout(timer);
      setStage("verified");
    };
    const observer = new IntersectionObserver(
      (entries) => {
        if (stopped || !entries.some((entry) => entry.isIntersecting)) return;
        stopped = true;
        observer.disconnect();
        timers.push(
          setTimeout(() => setStage("verifying"), VERIFYING_AFTER_MS),
          setTimeout(() => setStage("verified"), VERIFIED_AFTER_MS),
        );
      },
      { threshold: THRESHOLD },
    );
    observer.observe(element);
    motion.addEventListener("change", still);
    return () => {
      stopped = true;
      observer.disconnect();
      motion.removeEventListener("change", still);
      for (const timer of timers) clearTimeout(timer);
    };
  }, []);

  return { ref, stage };
}
