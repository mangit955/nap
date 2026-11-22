"use client";

/**
 * Which heading the reader is in: the last one whose top has scrolled above the reading line just
 * under the bar — where a heading lands when a link is followed to it. The "On this page" list and the sidebar both mark it.
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

/**
 * How far below a heading's landing position the reading line sits. A heading followed from a
 * link lands at its `scroll-margin-top`, which is taller on a phone, where a second bar sits under
 * the first; reading the line from the heading's own margin keeps a heading just jumped to marked
 * at every width. The slack covers a heading that lands a few pixels low — browser zoom, sub-pixel
 * rounding, a bar still settling — and is far less than the gap between any two headings.
 */
const SLACK = 24;

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
      const elements = list.flatMap((id) => {
        const element = document.getElementById(id);
        return element ? [{ id, element }] : [];
      });
      const first = elements[0]?.element;
      const line =
        (first ? Number.parseFloat(getComputedStyle(first).scrollMarginTop) || 0 : 0) + SLACK;
      const tops = elements.map(({ id, element }) => ({
        id,
        top: element.getBoundingClientRect().top,
      }));
      let current = tops.filter(({ top }) => top <= line).at(-1)?.id ?? null;
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
    // The page can move under a still window: a web font swapping in reflows every heading after
    // the first measurement, and a page opened at a heading's address is measured before it has.
    const layout = new ResizeObserver(schedule);
    layout.observe(document.body);
    return () => {
      layout.disconnect();
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
      if (frame !== 0) window.cancelAnimationFrame(frame);
    };
  }, [key]);

  return active;
}
