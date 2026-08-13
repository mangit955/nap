"use client";

/**
 * Content that arrives as you reach it.
 *
 * **It starts visible and is only hidden once JavaScript has taken responsibility for showing it
 * again.** That ordering is the whole design. Written the obvious way — hidden in the markup,
 * revealed by an observer — every failure mode is a blank page: no script, a thrown effect, an
 * observer that never fires because the section is taller than the viewport. Here the first
 * render has no `data-reveal` at all, so the stylesheet has nothing to hide, and the worst case
 * is a page that simply does not animate.
 *
 * **It never goes back.** Content that re-hides when you scroll up is the tell of an effect
 * applied for its own sake, and it punishes exactly the person who scrolled back to reread
 * something. So the observer disconnects the moment it fires.
 *
 * Under reduced motion no observer is created and the state stays `idle`, which is the same
 * markup a browser without the API gets. The stylesheet also neutralises the transition under
 * that query — the two together, because a hook and a media query that disagree is a bug nobody
 * sees until somebody with the setting turned on visits.
 */

import { type CSSProperties, type RefObject, useEffect, useRef, useState } from "react";
import { useReducedMotion } from "../glow/use-pulse.ts";

export type RevealState = "idle" | "pending" | "in";

/** How much of an element has to be showing before it counts as reached. */
const THRESHOLD = 0.15;
/** Trims the bottom of the viewport, so a section reveals just after it enters rather than at the
 *  instant its first pixel does — arriving *with* the scroll rather than ahead of it. */
const ROOT_MARGIN = "0px 0px -10% 0px";

export function useReveal<T extends HTMLElement>(): {
  ref: RefObject<T | null>;
  state: RevealState;
} {
  const ref = useRef<T>(null);
  const [state, setState] = useState<RevealState>("idle");
  const { reduced } = useReducedMotion();

  useEffect(() => {
    const element = ref.current;
    // `reduced` is false for the first render — `useReducedMotion` reads the query in its own
    // effect — so this has to put the state *back*, not merely decline to arm it. Returning early
    // would leave content that armed a frame ago hidden with nothing left to reveal it.
    if (reduced) {
      setState("idle");
      return;
    }
    if (element === null) return;
    // No observer to fall back on: leave the content where it is rather than hiding something
    // nothing will ever bring back.
    if (typeof IntersectionObserver !== "function") return;

    setState("pending");

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setState("in");
          observer.disconnect();
        }
      },
      { threshold: THRESHOLD, rootMargin: ROOT_MARGIN },
    );
    observer.observe(element);

    return () => observer.disconnect();
  }, [reduced]);

  return { ref, state };
}

/**
 * What to put on the element. `undefined` while idle, so the markup carries no attribute at all
 * and the hiding rule cannot match — see above.
 */
export function revealProps(
  state: RevealState,
  delayMs = 0,
): {
  className: string;
  "data-reveal": RevealState | undefined;
  style: CSSProperties | undefined;
} {
  return {
    className: "nap-reveal",
    "data-reveal": state === "idle" ? undefined : state,
    // A custom property is not part of `CSSProperties`, and this is the cast React's own types
    // expect for one — the alternative is a stylesheet rule per delay.
    style: delayMs > 0 ? ({ "--nap-reveal-delay": `${delayMs}ms` } as CSSProperties) : undefined,
  };
}
