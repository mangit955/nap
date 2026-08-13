"use client";

/**
 * Whether the demo is allowed to run.
 *
 * Three conditions, and they are here together because they fail in three different ways and each
 * one is easy to forget on its own: the stage has to be **on screen**, the tab has to be
 * **visible**, and the reader must not have asked for **less motion**. A loop that keeps tracing
 * an outline sixty times a second inside a background tab is the classic version of this bug — it
 * costs somebody's battery and nobody ever sees it happen.
 *
 * Unlike `useReveal`, the observer stays subscribed: this answers "is it playing *now*", which
 * changes every time the section scrolls past, where the reveal is a one-way door.
 *
 * It reports `false` until it has been told otherwise, so nothing starts running during the first
 * render, before anything is known about where the element is or whether the page is even shown.
 */

import { type RefObject, useEffect, useState } from "react";
import { useReducedMotion } from "../../glow/use-pulse.ts";

export function usePlaying(ref: RefObject<Element | null>): boolean {
  const { reduced } = useReducedMotion();
  const [onScreen, setOnScreen] = useState(false);
  const [shown, setShown] = useState(true);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    // No observer means no way to know when the section leaves, and a loop that never stops is
    // worse than an effect that never starts.
    if (typeof IntersectionObserver !== "function") return;

    const observer = new IntersectionObserver(
      (entries) => setOnScreen(entries.some((entry) => entry.isIntersecting)),
      // Any part of it showing counts: the stage is most of a screen tall, and a threshold would
      // stop the demo while a reader was still looking at half of it.
      { threshold: 0 },
    );
    observer.observe(element);

    return () => observer.disconnect();
  }, [ref]);

  useEffect(() => {
    const onChange = () => setShown(!document.hidden);
    onChange();
    document.addEventListener("visibilitychange", onChange);

    return () => document.removeEventListener("visibilitychange", onChange);
  }, []);

  return onScreen && shown && !reduced;
}
