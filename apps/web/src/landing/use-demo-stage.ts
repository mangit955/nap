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

import { type RefObject, useEffect, useLayoutEffect, useRef, useState } from "react";
export type DemoStage = "working" | "verifying" | "verified";

/** When the plan is three steps in, the app is in Preview and the checks are running. */
export const VERIFYING_AFTER_MS = 2400;
/** When the checks have passed and the session is done. */
export const VERIFIED_AFTER_MS = 5000;
/** Enough of the window showing that the run is not playing to the top of the fold. */
const THRESHOLD = 0.35;
/** Or, in a window too short to show that much, this much of the window filled by it. */
const FILLS_WINDOW = 0.6;
/**
 * Every twentieth of the hero, so a window too short for `THRESHOLD` still hears about it filling
 * up: coarser steps can jump past the fill while the reader scrolls.
 */
const THRESHOLDS = Array.from({ length: 21 }, (_, step) => step / 20);

/**
 * In view enough to play to. The ratio, not `isIntersecting`: an observer delivers a first entry
 * whatever its thresholds, and one row of pixels at the bottom of the screen counts as
 * intersecting.
 */
function inView(entry: IntersectionObserverEntry): boolean {
  if (!entry.isIntersecting) return false;
  if (entry.intersectionRatio >= THRESHOLD) return true;
  const viewport = entry.rootBounds?.height;
  return viewport !== undefined && entry.intersectionRect.height >= viewport * FILLS_WINDOW;
}

/** How long after mounting the hero stops waiting for its first frame to draw. */
export const READY_WAIT_MS = 4000;

/**
 * `ready` says the first beat has drawn: its diff is drawn on the client, a moment after the page,
 * and a clock started before it would spend the beat on "Loading diff…". It is only waited for so
 * long (`READY_WAIT_MS`), so a chunk that never loads cannot hold the hero at its first beat.
 */
export function useDemoStage<T extends HTMLElement>(
  ready = true,
): {
  ref: RefObject<T | null>;
  stage: DemoStage;
} {
  const ref = useRef<T>(null);
  const [stage, setStage] = useState<DemoStage>("working");
  // Read from the observer's callback, which outlives the render that set it.
  const isReady = useRef(ready);
  // The run's start, waiting for `ready`; it checks that the hero is still in view.
  const startWhenReady = useRef<(() => void) | null>(null);
  useEffect(() => {
    isReady.current = ready;
    if (ready) startWhenReady.current?.();
  }, [ready]);

  // A layout effect, so under reduced motion the verified result is in place before the first
  // paint after hydration. The demo is hidden until it has been measured (`demo.css`), so the
  // server's first beat is never what such a visitor sees.
  useLayoutEffect(() => {
    const element = ref.current;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (motion.matches || typeof IntersectionObserver !== "function" || element === null) {
      setStage("verified");
      return;
    }
    const timers: ReturnType<typeof setTimeout>[] = [];
    // Set once the run may no longer start: it has started, motion was reduced, or the hero went
    // away. An observer can still deliver an entry it queued before `disconnect`, so the callback
    // asks this rather than trusting the disconnect.
    let stopped = false;
    // Whether the hero is in view now. Watched until the run starts, so a frame that draws after
    // the reader has scrolled on waits for them to come back rather than playing to nobody.
    let visible = false;
    let waitedForFrame = false;
    const play = () => {
      if (stopped || !visible || !(isReady.current || waitedForFrame)) return;
      stopped = true;
      startWhenReady.current = null;
      observer.disconnect();
      timers.push(
        setTimeout(() => setStage("verifying"), VERIFYING_AFTER_MS),
        setTimeout(() => setStage("verified"), VERIFIED_AFTER_MS),
      );
    };
    // Turning reduced motion on mid-visit ends the run where it would have finished.
    const still = (event: MediaQueryListEvent) => {
      if (!event.matches) return;
      stopped = true;
      startWhenReady.current = null;
      observer.disconnect();
      for (const timer of timers) clearTimeout(timer);
      setStage("verified");
    };
    const observer = new IntersectionObserver(
      (entries) => {
        const latest = entries.at(-1);
        if (stopped || latest === undefined) return;
        visible = inView(latest);
        play();
      },
      { threshold: THRESHOLDS },
    );
    startWhenReady.current = play;
    timers.push(
      setTimeout(() => {
        waitedForFrame = true;
        play();
      }, READY_WAIT_MS),
    );
    observer.observe(element);
    motion.addEventListener("change", still);
    return () => {
      stopped = true;
      startWhenReady.current = null;
      observer.disconnect();
      motion.removeEventListener("change", still);
      for (const timer of timers) clearTimeout(timer);
    };
  }, []);

  return { ref, stage };
}
