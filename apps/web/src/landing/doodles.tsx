/**
 * Hand-drawn marks in the margins of the stage.
 *
 * They are here to stop a very pale surface reading as an empty one. A large light area with a
 * single object in the middle of it looks unfinished rather than calm, and the usual fixes —
 * a gradient, a grid, a noise texture — all put something *behind* the card that competes with
 * the light coming off it. Line art at a whisper does not: it is thin, it is neutral grey, and
 * it lives at the edges.
 *
 * Three rules keep it from becoming decoration for its own sake.
 *
 * **Nothing in the centre column.** The card's outermost glow layer paints 116px past its own
 * box, and anything under that halo is a shape being lit by coloured light — which reads as a
 * smudge rather than as a drawing. The marks sit outside it, at the left and right of the
 * stage, and the whole layer is dropped below `md` where there are no margins left to draw in.
 *
 * **Neutral, never tinted.** The stage drifts through a colour arc every few seconds. Anything
 * here that carried a hue would drift with it and start competing with the rim; grey stays put
 * and lets the light be the only thing moving.
 *
 * **They mean something.** A window, a terminal, a cursor, braces, a stack, a spark — the same
 * family of objects the card is cycling through. Generic squiggles would say only that somebody
 * wanted the page to look friendlier.
 *
 * The whole layer is `aria-hidden` and cannot be pointed at: it is texture, and there is nothing
 * in it a person needs described.
 */

/**
 * Shared line weight and joins, so every mark looks drawn by the same hand.
 *
 * `aria-hidden` is deliberately *not* in here even though every mark needs one — it is written
 * out on each `<svg>` instead, because the lint rule that catches an unlabelled drawing cannot
 * see an attribute arriving through a spread, and a rule that silently stops applying is worse
 * than the repetition it would have saved.
 */
const STROKE = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export function Doodles() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 hidden text-[var(--s-doodle)] md:block"
    >
      {/* A browser window, roughed in. */}
      <Mark className="top-[18%] left-[4%] size-24 -rotate-6">
        <svg viewBox="0 0 64 52" aria-hidden="true" {...STROKE}>
          <path d="M4 8.5C4 6 6 4.2 8.6 4.2h46.6C57.9 4.2 60 6.2 60 8.8v34.4c0 2.6-2 4.5-4.7 4.4L8.4 47.4C5.9 47.3 4 45.3 4 42.8Z" />
          <path d="M4.4 15.2 59.7 15" />
          <path d="M10 9.8h.05M15 9.8h.05M20 9.8h.05" />
          <path d="M12 24h22M12 31h30M12 38h14" />
        </svg>
      </Mark>

      {/* A prompt waiting for a command. */}
      <Mark className="top-[52%] left-[7%] size-16 rotate-3">
        <svg viewBox="0 0 48 32" aria-hidden="true" {...STROKE}>
          <path d="M8 9.5 15.5 16 8 22.5" />
          <path d="M21 23h14" />
        </svg>
      </Mark>

      {/* A stack of files, leaning. */}
      <Mark className="bottom-[14%] left-[5%] size-20 rotate-6">
        <svg viewBox="0 0 56 48" aria-hidden="true" {...STROKE}>
          <path d="M6 15.5 27.5 6l22 9.4-22 9.6Z" />
          <path d="M6 24.4 27.6 34l21.9-9.6" />
          <path d="M6 33.2 27.6 42.8l21.9-9.6" />
        </svg>
      </Mark>

      {/* Braces — code, without drawing any. */}
      <Mark className="top-[22%] right-[5%] size-16 rotate-6">
        <svg viewBox="0 0 44 44" aria-hidden="true" {...STROKE}>
          <path d="M17 6c-4.4.4-5.6 2.6-5.6 6.4 0 4.6.4 6.6-4.4 7.4v.6c4.8.8 4.4 3 4.4 7.6 0 3.8 1.2 6 5.6 6.4" />
          <path d="M27 6c4.4.4 5.6 2.6 5.6 6.4 0 4.6-.4 6.6 4.4 7.4v.6c-4.8.8-4.4 3-4.4 7.6 0 3.8-1.2 6-5.6 6.4" />
        </svg>
      </Mark>

      {/* A cursor, just after a click. */}
      <Mark className="top-[58%] right-[7%] size-14 -rotate-12">
        <svg viewBox="0 0 40 44" aria-hidden="true" {...STROKE}>
          <path d="M11 6.5 30 22.4l-8.6 1.4 4.6 9.8-3.6 1.7-4.7-9.8-6.6 5.6Z" />
          <path d="M33 8.4 36.6 5M33.6 14.6l4.8-.6M27.4 3.4l.4-3" />
        </svg>
      </Mark>

      {/* A spark, for the part that is supposed to feel like magic. */}
      <Mark className="right-[11%] bottom-[18%] size-12 rotate-12">
        <svg viewBox="0 0 36 36" aria-hidden="true" {...STROKE}>
          <path d="M18 4c0 7.2 3.4 12.6 12 14-8.6 1.4-12 6.8-12 14-.1-7.2-3.5-12.6-12-14 8.5-1.4 11.9-6.8 12-14Z" />
        </svg>
      </Mark>

      {/* An arrow, drawn by somebody pointing at the thing in the middle. */}
      <Mark className="top-[40%] left-[15%] hidden h-10 w-24 lg:block">
        <svg viewBox="0 0 96 40" aria-hidden="true" {...STROKE}>
          <path d="M4 30c14-16 34-22 62-19" />
          <path d="M56 4.6 68 11.4l-9 8" />
        </svg>
      </Mark>
    </div>
  );
}

/** Positions one mark. Every child is a square-ish svg scaled by the class it is given. */
function Mark({ className, children }: { className: string; children: React.ReactNode }) {
  return <div className={`absolute ${className}`}>{children}</div>;
}
