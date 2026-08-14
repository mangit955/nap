/**
 * Marks in the margins of the stage, drawn the way a person draws.
 *
 * They are here to stop a very pale surface reading as an empty one. A large light area with a
 * single object in the middle of it looks unfinished rather than calm, and the usual fixes —
 * a gradient, a grid, a noise texture — all put something *behind* the card that competes with
 * the light coming off it. Line art does not: it is thin, it is neutral grey, and it lives at
 * the edges.
 *
 * **What makes a drawing look machine-made is not the subject, it is the geometry.** A first
 * version of this used clean `h`/`v` runs and closed shapes, and read as clip art immediately.
 * Everything here is drawn against that, and every one of these is deliberate:
 *
 *   - **Corners overshoot.** Two strokes that cross slightly past their meeting point is the
 *     single strongest signal of a hand: nobody stops a pen exactly on a corner.
 *   - **No shape is closed by its own path.** Each side is its own stroke, so the joins are
 *     accidents rather than instructions.
 *   - **Straight lines bow.** Every "straight" run is a shallow curve that wanders by a pixel
 *     or two and does not end level with where it started.
 *   - **Nothing is parallel or evenly spaced.** The stack leans, the window's text lines are
 *     different lengths at slightly different angles, the spark's arms are uneven.
 *   - **Weight varies between marks**, because a person presses harder on some strokes.
 *
 * Three rules keep it from becoming decoration for its own sake. **Nothing in the centre
 * column** — the card's outermost glow layer paints 116px past its own box, and anything under
 * that halo is a shape being lit by coloured light, which reads as a smudge rather than a
 * drawing. **Neutral, never tinted** — the stage drifts through a colour arc every few seconds,
 * and anything here carrying a hue would drift with it and compete with the rim. **They mean
 * something** — a window, a terminal, a cursor, braces, a stack, a spark, all from the family
 * of objects the card is cycling through, because generic squiggles would say only that
 * somebody wanted the page to look friendlier.
 *
 * The whole layer is `aria-hidden` and cannot be pointed at: it is texture, and there is nothing
 * in it a person needs described.
 */

/**
 * Shared joins and caps, so every mark looks drawn by the same hand. Width is set per mark
 * rather than here, because a uniform line weight across a page of drawings is itself a tell.
 *
 * `aria-hidden` is deliberately *not* in here even though every mark needs one — it is written
 * out on each `<svg>` instead, because the lint rule that catches an unlabelled drawing cannot
 * see an attribute arriving through a spread, and a rule that silently stops applying is worse
 * than the repetition it would have saved.
 */
const PEN = {
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

export function Doodles() {
  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute inset-0 z-0 hidden text-[var(--s-doodle)] md:block"
      data-testid="landing-doodles"
    >
      {/*
        A window, roughed in. Four separate strokes, each running a little past the corner it
        meets, and three content lines of three different lengths — the thing that would give
        this away instantly is a evenly-spaced set of equal-length dashes.
      */}
      <Mark className="top-[16%] left-[4%] h-28 w-32 -rotate-6">
        <svg viewBox="0 0 72 58" aria-hidden="true" {...PEN} strokeWidth="1.7">
          <path d="M5.6 7.2c-.9 8.4-1.3 17-1.1 25.4.1 5.2.4 10.3.9 15.4" />
          <path d="M3.4 6.1c11.4-1.3 23-1.7 34.5-1.6 9.4.1 18.9.5 28.3 1.3" />
          <path d="M66.8 4.3c.7 8.9 1 17.9.8 26.8-.1 5.6-.4 11.2-1 16.7" />
          <path d="M67.6 47.6c-11.2 1.5-22.6 2-33.9 1.8-9.7-.2-19.4-.8-29-1.9" />
          <path d="M4.1 15.4c11.9-.9 23.9-1.3 35.9-1.2 8.9.1 17.8.4 26.7 1" />
          <path d="M9.6 10.3c.4.6.5 1.3.1 1.6M14.6 10.1c.5.5.6 1.3.2 1.7M19.7 10c.5.6.5 1.3 0 1.7" />
          <path d="M12.4 26.6c7.9-.7 15.9-.9 23.9-.6" />
          <path d="M12.1 34.1c11.4-.9 22.8-1 34.2-.4" />
          <path d="M12.8 41.3c5.2-.5 10.5-.7 15.8-.4" />
        </svg>
      </Mark>

      {/* A prompt waiting for a command. The chevron's two strokes cross past their meeting. */}
      <Mark className="top-[54%] left-[6%] h-16 w-20 rotate-3">
        <svg viewBox="0 0 56 34" aria-hidden="true" {...PEN} strokeWidth="2">
          <path d="M9.4 8.2c3.1 2.6 6 5.4 8.8 8.4" />
          <path d="M19.2 15.2c-3.2 3.1-6.5 6-10 8.7" />
          <path d="M25.6 24.4c5.8-.7 11.6-.9 17.5-.6" />
        </svg>
      </Mark>

      {/*
        A stack, leaning. The top sheet is four separate strokes that run past each other at the
        corners rather than one closed diamond — drawn as a single path it came out looking
        stamped, which is the exact failure this whole file is written against. The sheets below
        it are not parallel and the gaps between them are not equal.
      */}
      <Mark className="bottom-[13%] left-[5%] h-24 w-28 rotate-6">
        <svg viewBox="0 0 64 54" aria-hidden="true" {...PEN} strokeWidth="1.6">
          <path d="M5.2 17.4c8.6-4.2 17.4-7.9 26.4-11.2" />
          <path d="M29.8 5.6c8.2 3.1 16.2 6.6 24 10.6" />
          <path d="M54.6 15.4c-8.1 4.2-16.4 7.9-24.9 11.1" />
          <path d="M31.2 27.2c-8.6-3-17-6.6-25.2-10.7" />
          <path d="M5.8 26.2c7.5 4.2 15.4 7.8 23.4 10.8 8.3-2.8 16.3-6.4 23.9-10.8" />
          <path d="M7.2 35.8c7.2 4.4 14.9 8.1 22.8 11.1 8.1-3.4 15.9-7.4 23.3-12" />
        </svg>
      </Mark>

      {/* Braces — code, without drawing any. */}
      <Mark className="top-[20%] right-[5%] h-20 w-16 rotate-6">
        <svg viewBox="0 0 48 52" aria-hidden="true" {...PEN} strokeWidth="1.8">
          <path d="M18.6 6.4c-4.8.9-5.9 3.4-5.6 7.5.3 4.9 1 8.4-4.6 9.9 5.4 1.6 4.6 5.1 4.3 10-.2 4.1 1 6.5 5.8 7.3" />
          <path d="M30.4 6.1c4.7 1.1 5.7 3.6 5.2 7.7-.5 4.9-1.3 8.3 4.2 10-5.5 1.4-4.8 4.9-4.4 9.8.3 4.1-.8 6.6-5.5 7.5" />
        </svg>
      </Mark>

      {/* A cursor, just after a click. The outline breaks; the ticks are three lengths. */}
      <Mark className="top-[56%] right-[6%] h-20 w-20 -rotate-12">
        <svg viewBox="0 0 48 52" aria-hidden="true" {...PEN} strokeWidth="1.7">
          <path d="M13.4 9.2c6.9 5.7 13.5 11.7 19.9 18-3.2.7-6.4 1.2-9.7 1.5 2 3.6 3.8 7.3 5.4 11.1-1.4.8-2.9 1.4-4.4 1.9-1.8-3.7-3.8-7.4-5.9-10.9-2.5 2.1-4.9 4.3-7.2 6.6-.4-9.5-.2-19 .7-28.4" />
          <path d="M37.9 11.6c1.6-1.5 3.1-3 4.6-4.6M38.2 18.9c2.1-.5 4.2-.8 6.3-1M31.4 5.6c.1-1.6.1-3.3 0-4.9" />
        </svg>
      </Mark>

      {/*
        A spark. Three crossing strokes rather than a closed four-pointed star: the star is what
        an icon set draws, the crossing strokes are what a person draws.
      */}
      <Mark className="right-[10%] bottom-[17%] h-16 w-16 rotate-12">
        <svg viewBox="0 0 44 44" aria-hidden="true" {...PEN} strokeWidth="1.8">
          <path d="M21.6 5.4c.6 10.6.4 21.2-.6 31.8" />
          <path d="M7.2 20.4c9.8 1.1 19.7 1.3 29.6.6" />
          <path d="M11.6 10.8c6.7 6.9 13.7 13.4 21 19.6" />
        </svg>
      </Mark>

      {/* An arrow, drawn by somebody pointing at the thing in the middle. */}
      <Mark className="top-[38%] left-[14%] hidden h-14 w-28 lg:block">
        <svg viewBox="0 0 104 46" aria-hidden="true" {...PEN} strokeWidth="1.7">
          <path d="M5.4 36.8C15 22.4 31.2 13.4 49.6 10.2c8.2-1.4 16.6-1.6 24.9-.7" />
          <path d="M64.4 3.2c4.2 2.3 8.2 4.9 12 7.8" />
          <path d="M75.6 10.4c-3.4 2.6-6.6 5.5-9.6 8.6" />
        </svg>
      </Mark>

      {/* An underline someone put in twice, because the first one was not quite right. */}
      <Mark className="bottom-[26%] left-[13%] hidden h-8 w-24 -rotate-3 lg:block">
        <svg viewBox="0 0 96 24" aria-hidden="true" {...PEN} strokeWidth="1.6">
          <path d="M5.2 9.6c14.4 2.8 29.2 3.4 43.8 1.8 12.4-1.4 24.6-4.4 36.4-8.8" />
          <path d="M8.4 15.8c13.8 3.4 28.2 4.2 42.4 2.4 11-1.4 21.8-4.2 32.2-8.2" />
        </svg>
      </Mark>
    </div>
  );
}

/** Positions one mark. Every child is an svg scaled by the class it is given. */
function Mark({ className, children }: { className: string; children: React.ReactNode }) {
  return <div className={`absolute ${className}`}>{children}</div>;
}
