"use client";

/**
 * Words resolving out of blur as the agent produces them.
 *
 * The text genuinely grows — the model's reasoning arrives in phrase-sized pieces and the
 * transcript folds a run of them into one passage — so nothing here is on a timer. What
 * animates is exactly the words that were not on screen a moment ago, which is why this reads
 * as the sentence being written rather than as a canned effect replaying.
 *
 * **A word is animated once, and keeps that decision forever.** The obvious version compares
 * the current word count against the previous one, and it is wrong in a way that only shows on
 * screen: a word that was new last frame is old this frame, so it loses the class, loses
 * `animation-fill-mode: both` with it, and snaps from mid-blur to sharp. The delays live in a
 * ref keyed by word index and are assigned the first time an index is rendered.
 *
 * **`live` is what separates being watched from being replayed.** Opening a project replays
 * its whole log; a passage that re-ran its reveal then would say the agent is working when it
 * finished yesterday. History renders flat, and so does a turn that has ended.
 *
 * **The passage is not announced.** The transcript is a `role="log"`, so anything inside it is
 * a live region by inheritance, and reasoning that grows twice a second would be read aloud
 * twice a second — over the top of the step lines, which carry the facts worth hearing. The
 * words are also duplicated into one visually-hidden run, because a screen reader walking a
 * span per word hears "I. should. read." instead of a sentence.
 */

import { useRef } from "react";

/** The class the words wear. Exported because the effect has no other observable surface. */
export const REVEAL_CLASS = "nap-stream-word";

/** Between one word lighting up and the next. Fast enough to read as a wave, not a queue. */
const STAGGER_MS = 38;

/**
 * The stagger is capped so a long passage arriving at once does not schedule its last word
 * a minute out. Beyond this, everything lands together.
 */
const MAX_STAGGER_STEPS = 12;

export function StreamingText({ text, live }: { text: string; live: boolean }) {
  // Kept across renders and never read during one: the value for an index is written the
  // first time that index appears and is never recomputed.
  const delays = useRef(new Map<number, number>());

  if (!live) {
    return <span className="whitespace-pre-wrap">{text}</span>;
  }

  // Trailing space preserved on each word so the passage still reads as prose when the
  // spans are laid out inline.
  const words = text.split(" ");
  const firstNew = delays.current.size;

  return (
    <span aria-live="off" className="whitespace-pre-wrap">
      {/*
        The whole passage, for anything reading rather than looking. `aria-hidden` on the
        animated copy is what stops it being heard twice.
      */}
      <span className="sr-only">{text}</span>

      <span aria-hidden="true">
        {words.map((word, index) => {
          let delay = delays.current.get(index);
          if (delay === undefined) {
            delay = Math.min(index - firstNew, MAX_STAGGER_STEPS) * STAGGER_MS;
            delays.current.set(index, delay);
          }

          return (
            // The index *is* the word's identity here: a passage only ever grows at its end,
            // so nothing reorders and there is nothing else stable to key by.
            // biome-ignore lint/suspicious/noArrayIndexKey: position is the identity
            <span key={index} className={REVEAL_CLASS} style={{ animationDelay: `${delay}ms` }}>
              {index === words.length - 1 ? word : `${word} `}
            </span>
          );
        })}
      </span>

      {/* Named by a data attribute rather than a class, so it survives restyling. */}
      <span aria-hidden="true" data-caret className="nap-stream-caret" />
    </span>
  );
}
