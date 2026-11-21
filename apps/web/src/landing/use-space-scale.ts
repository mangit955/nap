"use client";

/**
 * Fits a fixed design space to the width it is actually given.
 *
 * The landing page's demos draw the product's own components at the size the product lays them
 * out for, and those components do not reflow into a column a third that wide. Something then has
 * to shrink that space to the column it lands in, and this is it: one ratio, written to the
 * element as a custom property the stylesheet scales by, and the layout it was computed for.
 *
 * **It measures, which is the second attempt.** The first was pure CSS —
 * `scale: calc(100cqw / 460)` — and it is silently invalid: `scale` takes a *number*, a container
 * unit is a *length*, and a length over a number is still a length. The browser drops the whole
 * declaration, the computed style reads `scale: none`, and the space renders at 1:1 and overflows
 * its column on any screen narrower than the design. There is no warning anywhere, the class is
 * sitting right there in the markup, and the only way to catch it is to read the computed style.
 * The same is true of the Tailwind arbitrary-property spellings of it, which additionally compile
 * to no rule at all.
 *
 * A `useLayoutEffect`, so the ratio is in place before the first paint rather than one frame of
 * full-size content later.
 */

import { type RefObject, useLayoutEffect, useRef } from "react";

/** What the stylesheet reads. Defaults to 1, so markup nothing has measured is simply unscaled. */
const VAR = "--space-k";

/** The space a box draws at, and the name of its layout, which goes to `data-space`. */
export type SpaceChoice = { width: number; layout: string };

/**
 * `choose` picks the space for the width the box was given: a phone gets a narrower space rather
 * than the desktop one shrunk. The layout it names is written to `data-space`, so the stylesheet
 * lays the space out for exactly the width the ratio was computed for.
 */
export function useSpaceScale(
  ref: RefObject<HTMLElement | null>,
  choose: (width: number) => SpaceChoice,
): void {
  // Read through a ref so a function written inline does not re-run the effect on every render.
  const current = useRef(choose);
  useLayoutEffect(() => {
    current.current = choose;
  });

  useLayoutEffect(() => {
    const host = ref.current;
    if (host === null) return;

    const fit = () => {
      const width = host.getBoundingClientRect().width;
      // A zero width is a box that has not been laid out — in a test, in a `display: none`
      // ancestor, during a print. Scaling to zero there would hide the section outright, where
      // leaving the last known ratio alone costs nothing.
      if (width <= 0) return;
      const space = current.current(width);
      if (space.width <= 0) return;
      host.style.setProperty(VAR, `${width / space.width}`);
      host.dataset.space = space.layout;
    };

    fit();

    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(fit);
    observer.observe(host);

    return () => observer.disconnect();
  }, [ref]);
}
