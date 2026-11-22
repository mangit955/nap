"use client";

/**
 * Which heading the reader is in: the last one whose top has scrolled above the reading line just
 * under the bar. The "On this page" list and the sidebar both mark it.
 *
 * Measured on scroll, once a frame, rather than with an `IntersectionObserver`: an observer reports
 * headings entering and leaving a band, and turning those edges into "the section I am reading" on
 * a page whose sections run from one paragraph to twenty needs exactly this position test anyway.
 *
 * At the foot of the page the last heading may never reach the line, because there is not enough
 * page below it to scroll that far. Once nothing more can scroll, the last heading on screen wins,
 * or a short final section could never be marked at all.
 */

import { useEffect, useState } from "react";

/** The reading line, in pixels from the top of the viewport: under the bar, with some air. */
const READING_LINE = 120;

export function useActiveHeading(ids: readonly string[]): string | null {
  const [active, setActive] = useState<string | null>(null);
  // A string, so a new array with the same ids does not restart the listener.
  const key = ids.join(" ");

  useEffect(() => {
    const list = key ? key.split(" ") : [];
    if (list.length === 0) {
      setActive(null);
      return;
    }

    let frame = 0;
    const measure = () => {
      frame = 0;
      const tops = list.flatMap((id) => {
        const element = document.getElementById(id);
        return element ? [{ id, top: element.getBoundingClientRect().top }] : [];
      });
      let current = tops.filter(({ top }) => top <= READING_LINE).at(-1)?.id ?? null;
      const root = document.documentElement;
      const atBottom = window.innerHeight + window.scrollY >= root.scrollHeight - 2;
      if (atBottom) {
        current = tops.filter(({ top }) => top < window.innerHeight).at(-1)?.id ?? current;
      }
      setActive(current);
    };
    const schedule = () => {
      if (frame === 0) frame = window.requestAnimationFrame(measure);
    };

    measure();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, [key]);

  return active;
}
