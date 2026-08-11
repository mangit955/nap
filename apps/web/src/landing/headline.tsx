"use client";

/**
 * The page's first sentence, and the only place on it where the light touches type.
 *
 * Two things are happening, and they are on different clocks on purpose.
 *
 * **It arrives a word at a time.** Each word comes up out of a blur on a stagger, once, on load.
 * Per *word* rather than per character, unlike the card's contents: a headline set at this size
 * spelled out letter by letter reads as a typewriter gimmick, where a word stagger reads as a
 * sentence being said. The blur is what stops the travel looking like a slide.
 *
 * **Then the light catches it.** The ink stays solid near-black — this is not gradient text —
 * and a narrow band of the *stage's current palette colour* crosses the letters once per pulse.
 * The point is that it is the same light: `onSweep` is called from the beat that lights the
 * card's rim, so the type and the card are lit by one source rather than by two effects that
 * happen to be running. Anything else would drift out of step the first time the tab is hidden,
 * because the pulse loop stops while the tab is away and a CSS loop of its own would not.
 *
 * The sweep is a second background layer clipped to the glyphs, over a solid one. Filling the
 * text with the gradient alone is the usual way to do this and is wrong here: the letters would
 * *be* the colour, permanently, which is the look this page already spends on the rim.
 */

import { Fragment, useEffect, useRef } from "react";

/** Between one word's arrival and the next. Long enough to read as a cadence, not as a queue. */
const WORD_STAGGER_MS = 60;
const WORD_MS = 620;
/** The subheading follows the last word rather than racing it. */
const TAIL_MS = 160;

export function Headline({
  lines,
  sub,
  onReady,
}: {
  /** One string per visual line. Kept as lines because where a headline breaks is a decision. */
  lines: readonly string[];
  sub: string;
  /**
   * Handed the heading element once it is mounted, so the caller can drive `sweep` from
   * whatever clock it wants the light on. Nothing here owns a timer.
   */
  onReady?: (heading: HTMLHeadingElement | null) => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    onReady?.(heading.current);
    return () => onReady?.(null);
  }, [onReady]);

  let index = 0;
  const words = lines.map((line) =>
    line.split(" ").map((word) => ({ word, delay: index++ * WORD_STAGGER_MS })),
  );
  const settled = index * WORD_STAGGER_MS + WORD_MS;

  return (
    <>
      <h1
        ref={heading}
        className="nap-headline text-balance text-center font-semibold text-[2.6rem] leading-[1.02] tracking-[-0.045em] sm:text-[4.25rem]"
      >
        {words.map((line, lineIndex) => (
          // Lines are fixed content in source order and there is nothing else to key them on.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          <Fragment key={lineIndex}>
            <span className="block">
              {line.map(({ word, delay }) => (
                // The space belongs *between* the spans, not inside them. Written inside, the
                // accessible name computation trims each element's own text and the heading is
                // announced as one run-on word — identical on screen, unreadable aloud.
                <Fragment key={`${word}-${delay}`}>
                  <span className="nap-word" style={{ animationDelay: `${delay}ms` }}>
                    {word}
                  </span>{" "}
                </Fragment>
              ))}
            </span>
            {/*
            And a space between the lines, for the same reason: the break is a block boundary,
            which is a line break on screen and nothing at all in the accessible name.
          */}{" "}
          </Fragment>
        ))}
      </h1>

      <p
        className="nap-word mt-6 max-w-md text-balance text-center text-[var(--s-text-muted)] text-[15px] leading-relaxed sm:text-base"
        style={{ animationDelay: `${settled + TAIL_MS}ms` }}
      >
        {sub}
      </p>
    </>
  );
}

/**
 * Runs the light across the type once.
 *
 * The attribute goes false and then true across **two** frames, for the same reason the rim does
 * it: written in one frame the browser coalesces them and the animation never restarts, which
 * looks exactly like the sweep being broken rather than like a missed beat.
 */
export function sweep(heading: HTMLElement | null): void {
  if (heading === null) return;
  heading.dataset.sweeping = "false";
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      if (heading.isConnected) heading.dataset.sweeping = "true";
    });
  });
}
