/**
 * The page's first sentence. Plain text, set with intent — nothing here moves.
 *
 * The whole sentence is set in the display face at its **lightest** weight, in the body ink
 * rather than the darkest one, and a single word is set heavy and near-black. That contrast is
 * the entire treatment: at this size a light weight reads as composure, and one word carrying
 * all the weight puts the emphasis exactly where the sentence's meaning is, without a colour, a
 * rule, a highlight or an animation to help it.
 *
 * Which word is emphasised is the caller's decision, because it is a *copy* decision — it is the
 * one the sentence turns on, and it moves if the sentence is rewritten.
 *
 * The emphasis is a `<span>`, not a `<strong>`: the weight is typographic and means "look here",
 * where `<strong>` means the word carries more importance when the sentence is *read aloud*. The
 * two happen to coincide here, and will not the next time somebody changes the copy.
 */

import { Fragment } from "react";

const NOT_A_WORD = /[^\p{L}\p{N}]/gu;

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
  const target = emphasis.toLowerCase().replace(NOT_A_WORD, "");

  return (
    <>
      <h1 className="text-balance text-center font-display font-extralight text-[2.6rem] text-[var(--s-text-body)] leading-[1.04] tracking-[-0.035em] sm:text-[4.25rem]">
        {lines.map((line, lineIndex) => (
          // Lines are fixed content in source order and there is nothing else to key them on.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          <Fragment key={lineIndex}>
            <span className="block">
              {line.split(" ").map((word, wordIndex) => (
                // Same story: a word's identity in a fixed line is its position.
                // biome-ignore lint/suspicious/noArrayIndexKey: see above
                <Fragment key={wordIndex}>
                  {word.toLowerCase().replace(NOT_A_WORD, "") === target ? (
                    <span className="font-semibold text-[var(--s-text-primary)]">{word}</span>
                  ) : (
                    word
                  )}{" "}
                </Fragment>
              ))}
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
