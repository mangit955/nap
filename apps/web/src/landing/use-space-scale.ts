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

import { type RefObject, useLayoutEffect, useRef } from "react";

/** What the stylesheet reads. Defaults to 1, so markup nothing has measured is simply unscaled. */
const VAR = "--space-k";

/**
 * `designWidth` is a number, or a function of the width the box was given for a space whose
 * layout changes with it — a phone gets a narrower space rather than the desktop one shrunk. The
 * stylesheet has to switch layouts at the same width the function does.
 */
export function useSpaceScale(
  ref: RefObject<HTMLElement | null>,
  designWidth: number | ((width: number) => number),
): void {
  // Read through a ref so a function written inline does not re-run the effect on every render.
  const design = useRef(designWidth);
  useLayoutEffect(() => {
    design.current = designWidth;
  });
  const fixed = typeof designWidth === "number" ? designWidth : null;

  useLayoutEffect(() => {
    void fixed;
    const host = ref.current;
    if (host === null) return;

    const fit = () => {
      const width = host.getBoundingClientRect().width;
      // A zero width is a box that has not been laid out — in a test, in a `display: none`
      // ancestor, during a print. Scaling to zero there would hide the section outright, where
      // leaving the last known ratio alone costs nothing.
      if (width <= 0) return;
      const target = design.current;
      const space = typeof target === "number" ? target : target(width);
      if (space <= 0) return;
      host.style.setProperty(VAR, `${width / space}`);
    };

    fit();

    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(fit);
    observer.observe(host);

    return () => observer.disconnect();
  }, [ref, fixed]);
}
