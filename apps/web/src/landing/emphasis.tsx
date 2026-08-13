/**
 * One word set heavy in an otherwise evenly-set line.
 *
 * That contrast is the page's entire heading treatment: at display sizes a light weight reads as
 * composure, and a single heavy word puts the emphasis exactly where the sentence's meaning is,
 * without a colour, a rule, a highlight or an animation to help. It lives here rather than inside
 * the headline because the sections below the hero set their own headings the same way, and two
 * copies of a typographic rule is how two parts of one page start to disagree.
 *
 * The word is matched ignoring punctuation, so copy can say `nap.` while the caller says `nap`.
 * An emphasis matching nothing simply leaves the line evenly set — a heading with no heavy word
 * is a weaker heading, not a broken page.
 *
 * The emphasis is a `<span>`, not a `<strong>`: the weight is typographic and means "look here",
 * where `<strong>` means the word carries more importance when the sentence is *read aloud*. The
 * two coincide today and will not the next time somebody rewrites the copy.
 */

import { Fragment } from "react";

const NOT_A_WORD = /[^\p{L}\p{N}]/gu;

/** The comparable form of a word: lowercase, stripped of anything that is not a letter or digit. */
export function bareWord(word: string): string {
  return word.toLowerCase().replace(NOT_A_WORD, "");
}

export const HEAVY = "font-semibold text-[var(--s-text-primary)]";

export function Emphasised({ text, emphasis }: { text: string; emphasis: string }) {
  const target = bareWord(emphasis);

  return (
    <>
      {text.split(" ").map((word, index) => (
        // A word's identity inside a fixed line is its position; there is nothing else to key on.
        // biome-ignore lint/suspicious/noArrayIndexKey: see above
        <Fragment key={index}>
          {bareWord(word) === target ? <span className={HEAVY}>{word}</span> : word}{" "}
        </Fragment>
      ))}
    </>
  );
}
