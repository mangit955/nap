/**
 * The pointer that uses the demo.
 *
 * A drawing, nothing else: where it goes is `script.ts`'s business and the stage writes the
 * transform every frame. It exists because a demo with no pointer is a UI animating itself, and a
 * pointer is what makes the same frames read as somebody *using* the thing — which is the whole
 * difference between a screensaver and a product.
 *
 * The press is a ring that expands and fades, drawn *behind* the arrow so the arrow never
 * disappears inside its own feedback. It is a class rather than an inline animation so reduced
 * motion can stop it through the cascade, the way `.nap-spin` is handled.
 *
 * It is not a real cursor and must never behave like one: no pointer events, no hover states, and
 * it sits under `aria-hidden` with the rest of the stage.
 */

import type { RefObject } from "react";
import type { Frame } from "./script.ts";

export function DemoCursor({
  ref,
  frame,
}: {
  ref: RefObject<HTMLDivElement | null>;
  /** The frame the markup is first rendered from; every frame after that is written by the stage. */
  frame: Frame;
}) {
  return (
    <div
      ref={ref}
      data-press="false"
      className="nap-demo-cursor pointer-events-none absolute top-0 left-0"
      style={{
        transform: `translate(${frame.cursor.x}px, ${frame.cursor.y}px)`,
        opacity: frame.cursor.alpha,
      }}
    >
      {/* The ring is centred on the arrow's tip, which is where a click actually lands. */}
      <span className="nap-demo-press absolute size-6 rounded-full border border-[var(--s-text-primary)]" />

      <svg
        viewBox="0 0 16 20"
        className="relative size-5 drop-shadow-[0_1px_2px_rgba(12,38,77,0.35)]"
        aria-hidden="true"
      >
        <path
          d="M1.5 1.2 13.4 11.1 8.2 11.6 11 17.2 8.6 18.4 5.8 12.7 1.9 15.9z"
          fill="var(--s-surface-1)"
          stroke="var(--s-text-primary)"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}
