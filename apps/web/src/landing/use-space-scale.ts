"use client";

/**
 * Fits a fixed design space to the width it is actually given.
 *
 * Two things on this page — the poured bento and the live demo — place their contents in plain
 * pixels, because the shape drawn behind them is traced from those same numbers and a percentage
 * layout would put the contents somewhere the skin was never drawn for. Something then has to
 * shrink that space to the column it lands in, and this is it: one ratio, written to the element
 * as a custom property the stylesheet scales by.
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

import { type RefObject, useLayoutEffect } from "react";

/** What the stylesheet reads. Defaults to 1, so markup nothing has measured is simply unscaled. */
const VAR = "--space-k";

export function useSpaceScale(ref: RefObject<HTMLElement | null>, designWidth: number): void {
  useLayoutEffect(() => {
    const host = ref.current;
    if (host === null || designWidth <= 0) return;

    const fit = () => {
      const width = host.getBoundingClientRect().width;
      // A zero width is a box that has not been laid out — in a test, in a `display: none`
      // ancestor, during a print. Scaling to zero there would hide the section outright, where
      // leaving the last known ratio alone costs nothing.
      if (width <= 0) return;
      host.style.setProperty(VAR, `${width / designWidth}`);
    };

    fit();

    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(fit);
    observer.observe(host);

    return () => observer.disconnect();
  }, [ref, designWidth]);
}
