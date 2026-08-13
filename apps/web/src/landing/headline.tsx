/**
 * The page's first sentence. Plain text, set with intent — nothing here moves.
 *
 * The whole sentence is set in the display face at its **lightest** weight, in the body ink
 * rather than the darkest one, and a single word is set heavy and near-black; `emphasis.tsx`
 * owns that rule, because every heading further down the page is set the same way.
 *
 * Which word is emphasised is the caller's decision, because it is a *copy* decision — it is the
 * one the sentence turns on, and it moves if the sentence is rewritten.
 */

import { Fragment } from "react";
import { Emphasised } from "./emphasis.tsx";

export function Headline({
  lines,
  sub,
  emphasis,
}: {
  /** One string per visual line. Kept as lines because where a headline breaks is a decision. */
  lines: readonly string[];
  sub: string;
  /**
   * The word carrying the weight, matched ignoring punctuation so the copy can say `nap.` and
   * this can say `nap`. Anything matching nothing simply leaves the line evenly set.
   */
  emphasis: string;
}) {
  return (
    <>
      <h1 className="text-balance text-center font-display font-extralight text-[2.6rem] text-[var(--s-text-body)] leading-[1.04] tracking-[-0.035em] sm:text-[4.25rem]">
        {lines.map((line, lineIndex) => (
          // Lines are fixed content in source order and there is nothing else to key them on.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          <Fragment key={lineIndex}>
            <span className="block">
              <Emphasised text={line} emphasis={emphasis} />
            </span>
            {/*
              A space between the lines as well. The break is a block boundary, which is a line
              break on screen and nothing at all in the accessible name — without this the
              heading is announced as "an app.Then go".
            */}{" "}
          </Fragment>
        ))}
      </h1>

      <p className="mt-6 max-w-md text-balance text-center text-[var(--s-text-muted)] text-[15px] leading-relaxed sm:text-base">
        {sub}
      </p>
    </>
  );
}
