"use client";

/**
 * Text that arrives a character at a time, rather than appearing.
 *
 * Each letter comes up from sixteen pixels below, out of a two-pixel blur, on a twenty
 * millisecond stagger. The blur is what stops the travel reading as a slide, and the stagger is
 * the whole difference between text that *arrives* and text that is simply there.
 *
 * It has to be remounted on every handover — the caller keys it off a counter — because a CSS
 * animation only runs when the element is new. Rerendering the same spans with the same classes
 * plays nothing at all, which looks exactly like the animation being broken.
 *
 * Under reduced motion the letters fade in place: no travel, no blur, no stagger. The words
 * still arrive, they simply do not move.
 */

import type { CSSProperties } from "react";
import { useReducedMotion } from "./use-pulse.ts";

const STAGGER_MS = 20;
const CHAR_MS = 300;

export function RisingText({
  text,
  className = "",
  delay = 0,
}: {
  text: string;
  className?: string;
  delay?: number;
}) {
  const { reduced } = useReducedMotion();

  return (
    <span className={`block whitespace-nowrap leading-none ${className}`}>
      {Array.from(text).map((character, index) => (
        <span
          // Position genuinely is a character's identity here: the string is fixed for a given
          // variant, and the whole run is remounted wholesale on every handover rather than
          // being reconciled. There is nothing else about a letter to key on.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          key={`${index}-${character}`}
          className={
            reduced
              ? "inline-block animate-[ai-char-fade_var(--d)_ease_both] align-middle"
              : "inline-block animate-[ai-char_var(--d)_cubic-bezier(0.66,0,0.34,1)_both] align-middle"
          }
          style={
            {
              "--d": `${CHAR_MS}ms`,
              animationDelay: reduced ? `${delay}ms` : `${delay + index * STAGGER_MS}ms`,
              // An inline-block collapses a space to nothing, so the gap is drawn rather than
              // written. Without this every variant's text loses its word breaks.
              width: character === " " ? "0.28em" : undefined,
            } as CSSProperties
          }
        >
          {character === " " ? " " : character}
        </span>
      ))}
    </span>
  );
}
