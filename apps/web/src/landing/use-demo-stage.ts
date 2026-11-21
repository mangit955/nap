"use client";

/**
 * Plays the hero session's build once: the prompt, then the build, then the finished app.
 *
 * **It starts when somebody can see it.** The hero is usually on screen at load, but a visitor who
 * lands on `/#changelog` and scrolls up should see the build happen rather than its last frame.
 *
 * **It starts at the prompt, not the finish.** The server's HTML is the first frame, so starting
 * at `ready` and rewinding on hydration would flash the finished app and then take it away.
 *
 * **The finished app is the fallback, never the prompt.** Under reduced motion, and in a browser
 * with no `IntersectionObserver` to say the hero was seen, it goes straight to `ready`: the app
 * the visitor can click is what the hero is for, and a build that never starts would leave them
 * looking at a placeholder.
 */

import { type RefObject, useEffect, useRef, useState } from "react";
import type { DemoStage } from "./session-preview.tsx";

/** When the agent's reply and the running command appear. */
export const BUILDING_AFTER_MS = 900;
/** When the checks pass and the booking app replaces the placeholder. */
export const READY_AFTER_MS = 2600;
/** Enough of the window showing that the build is not playing to the top of the fold. */
const THRESHOLD = 0.35;

export function useDemoStage<T extends HTMLElement>(): {
  ref: RefObject<T | null>;
  stage: DemoStage;
} {
  const ref = useRef<T>(null);
  const [stage, setStage] = useState<DemoStage>("prompt");

  useEffect(() => {
    const element = ref.current;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (motion.matches || typeof IntersectionObserver !== "function" || element === null) {
      setStage("ready");
      return;
    }
    const timers: ReturnType<typeof setTimeout>[] = [];
    // Set once the build may no longer start. An observer can still deliver an entry it queued
    // before `disconnect`, so the callback asks this rather than trusting the disconnect.
    let stopped = false;
    // Turning reduced motion on mid-visit ends the build where it would have finished.
    const still = (event: MediaQueryListEvent) => {
      if (!event.matches) return;
      stopped = true;
      observer.disconnect();
      for (const timer of timers) clearTimeout(timer);
      setStage("ready");
    };
    const observer = new IntersectionObserver(
      (entries) => {
        if (stopped || !entries.some((entry) => entry.isIntersecting)) return;
        stopped = true;
        observer.disconnect();
        timers.push(
          setTimeout(() => setStage("building"), BUILDING_AFTER_MS),
          setTimeout(() => setStage("ready"), READY_AFTER_MS),
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
