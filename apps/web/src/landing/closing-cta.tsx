"use client";

/**
 * The last thing on the page, which is the first thing again.
 *
 * Somebody who has read this far has already been told what the product does; repeating the pitch
 * would be arguing with a decision they have made. So it is three words, the mark, and the same
 * two links the hero offers.
 *
 * The mark is asleep here and wakes when you point at it — the same drawing the header uses, with
 * the same hover. It is the page's one joke told once more at the end, and the only reward for
 * scrolling all the way down.
 */

import { NapMark } from "../brand/nap-mark.tsx";
import { Emphasised } from "./emphasis.tsx";
import { revealProps, useReveal } from "./use-reveal.ts";
import { WayIn } from "./way-in.tsx";

export function ClosingCta() {
  const { ref, state } = useReveal<HTMLDivElement>();

  return (
    <section aria-labelledby="closing" className="px-6 py-28 sm:py-36">
      <div ref={ref} {...revealProps(state)} className="flex flex-col items-center text-center">
        <NapMark className="size-16 text-[var(--s-text-primary)]" />

        <h2
          id="closing"
          className="mt-6 font-display font-extralight text-[2.4rem] text-[var(--s-text-body)] leading-[1.05] tracking-[-0.035em] sm:text-[3.4rem]"
        >
          <Emphasised text="Right then. Nap." emphasis="nap" />
        </h2>

        <p className="mt-5 max-w-sm text-balance text-[15px] text-[var(--s-text-muted)] leading-relaxed">
          A sentence is the whole setup. Everything after that happens in the sandbox.
        </p>

        {/* The way in and nothing else. The repository is a line below in the footer, and two
            copies of it inside one screen makes the last thing on the page a choice of three. */}
        <div className="mt-9">
          <WayIn />
        </div>
      </div>
    </section>
  );
}
