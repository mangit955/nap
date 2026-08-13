/**
 * A sheet of doodles behind the sign-in form: Nap, over and over, doing something different in
 * each one.
 *
 * The auth screen is the one page standing between a visitor and an account, and it was a white
 * card on a pale gradient with nothing else on it. That is the same problem the landing page
 * has — a large light surface with a single object in the middle of it reads as unfinished
 * rather than as calm — and the same answer, taken much further: not marks in the margins but a
 * wall, the way somebody fills a page of lined paper while they are on the phone.
 *
 * **The style rules are `landing/doodles.tsx`'s and they are not restated here.** Read that
 * file's comment before drawing anything new: corners overshoot, no shape is closed by its own
 * path, straight lines bow, nothing is parallel, weight varies between marks. Everything below
 * obeys them, and anything added later that does not will look stamped next to the rest.
 *
 * **Nap is drawn here rather than imported.** `NapMark` is a *filled* silhouette, which is what
 * makes it survive at 16px in a browser tab — and sixty filled ghosts on white paper is a page
 * of black blobs, not a doodle sheet. These are the same proportions in outline: the wide dome,
 * the straight shoulders, the three-bump hem, taken from `brand/nap-mark-paths.ts` by eye.
 *
 * **The layout is a table, not a random seed.** A layer that places itself randomly renders one
 * way on the server and another in the browser; React calls that a hydration mismatch, throws
 * the server's markup away, and the console fills up with it. Every position, angle and size
 * below is written down.
 *
 * The middle of the wall is cleared by a mask rather than by leaving a hole in the table — see
 * `.nap-doodle-wall` in `globals.css`. A hole would have to be re-cut every time the form
 * changed height; a radial mask simply is where the form is.
 *
 * `aria-hidden` and `pointer-events-none`, like every other decoration in this app: there is
 * nothing here to read and nothing here to press, and a full-screen layer that took clicks would
 * take them from the one form on the page.
 */

/** The shared hand. Width is per drawing — one weight across a whole page is itself a tell. */
const PEN = {
  fill: "none",
  stroke: "currentColor",
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

/**
 * Nap's outline, in two strokes that do not meet: the sides-and-dome, then the hem drawn back
 * the other way. One closed path came out looking like a cut-out sticker.
 */
const GHOST_ARCH =
  "M5.4 23.4C4.3 18.9 4.2 14.3 5.2 9.9 6.2 5.8 9.5 3.3 13.9 3.4c4.4.1 7.7 2.9 8.6 7.1.9 4.3.8 8.7 0 13";
const GHOST_HEM =
  "M22.4 23.2c-1 1.7-2.6 1.7-3.5.1-.9-1.5-2.4-1.5-3.4 0-1 1.6-2.7 1.6-3.6 0-.9-1.5-2.4-1.4-3.3.1-.8 1.4-2.3 1.4-3.2-.1";

type Face = "open" | "shut" | "squint" | "bored";

/** The body plus one of the four faces the real mark can pull. */
function Nap({ face = "open" }: { face?: Face }) {
  return (
    <>
      <path d={GHOST_ARCH} />
      <path d={GHOST_HEM} />
      {face === "open" && (
        <g fill="currentColor" stroke="none">
          <ellipse cx="10.3" cy="12.8" rx="1.15" ry="1.5" />
          <ellipse cx="17" cy="12.7" rx="1.15" ry="1.5" />
        </g>
      )}
      {face === "shut" && (
        <path d="M8.9 12.4c.6 1.5 1.6 2.2 2.6.1M15.4 12.3c.6 1.5 1.7 2.2 2.7.1" />
      )}
      {face === "squint" && <path d="m9 11 2.2 1.7L9 14.4M18.3 11 16 12.7l2.3 1.7" />}
      {face === "bored" && (
        <>
          <path d="M8.9 12.2c1.6-.3 3.2-.3 4.8 0M14.6 12.1c1.6-.3 3.2-.3 4.8 0" />
          <g fill="currentColor" stroke="none">
            <path d="M9.6 12.6c1.1-.2 2.2-.2 3.3 0 .2 1.1-.5 1.9-1.7 1.9s-1.8-.8-1.6-1.9Z" />
            <path d="M15.3 12.5c1.1-.2 2.2-.2 3.3 0 .2 1.1-.5 1.9-1.7 1.9s-1.8-.8-1.6-1.9Z" />
          </g>
        </>
      )}
    </>
  );
}

/**
 * The drawings, in one array so the placement table can point at them by number.
 *
 * Mostly Nap, with the props he works among between the poses — a wall of one silhouette starts
 * to read as a repeating pattern however much the poses differ, and the objects are what break
 * the rhythm. Every prop is from the same family as the landing page's: the things this product
 * is made of, not generic squiggles.
 */
const DOODLES: readonly (() => React.JSX.Element)[] = [
  // 0 — Nap, just standing there.
  () => (
    <svg viewBox="0 0 28 28" aria-hidden="true" {...PEN} strokeWidth="1.5">
      <Nap />
    </svg>
  ),

  // 1 — asleep, with two z's leaving. The z's are different sizes: they have been going a while.
  () => (
    <svg viewBox="0 0 34 28" aria-hidden="true" {...PEN} strokeWidth="1.5">
      <Nap face="shut" />
      <path d="M23.8 10.4h3.1l-3.2 3.3h3.4M28.4 5.6h2.4l-2.5 2.6h2.6" strokeWidth="1.2" />
    </svg>
  ),

  // 2 — headphones on, eyes screwed shut, a note leaving. The cups are filled: at this size an
  // outlined pad is four thin arcs sitting on top of a head and dissolves into it.
  () => (
    <svg viewBox="0 0 34 28" aria-hidden="true" {...PEN} strokeWidth="1.5">
      <Nap face="squint" />
      <path d="M5.8 12.4C5.4 7.4 8.6 3.7 13.8 3.6c5.2-.1 8.5 3.4 8.4 8.5" strokeWidth="1.3" />
      <path
        d="M5.6 11.9c-1.3.2-2 1.2-2 2.8 0 1.7.6 2.7 1.9 2.9.9.1 1.4-.4 1.4-1.3v-3.1c0-.9-.5-1.4-1.3-1.3ZM22.3 11.8c1.3.1 2 1.1 2.1 2.7.1 1.7-.5 2.7-1.8 3-.9.2-1.4-.3-1.5-1.2l-.1-3.1c0-.9.4-1.4 1.3-1.4Z"
        fill="currentColor"
        strokeWidth="0.9"
      />
      <path d="M27.4 12.6V7.2l3.4-1v5.2" strokeWidth="1.2" />
      <path d="M25.9 12.3c.3-.9 1.4-1.2 1.6-.1M29.3 11.3c.3-.9 1.4-1.2 1.6-.1" strokeWidth="1.2" />
    </svg>
  ),

  // 3 — at a laptop, peeking over the lid. The base is what makes it a laptop: with only the
  // lid he was a ghost standing behind a wall.
  () => (
    <svg viewBox="0 0 34 30" aria-hidden="true" {...PEN} strokeWidth="1.5">
      <path d="M7.6 15.6c-.9-3.6-1-7 0-10C8.7 2.3 11.6.4 15.4.6c3.8.2 6.5 2.3 7.2 5.8.6 3.1.5 6.2-.2 9.2" />
      <g fill="currentColor" stroke="none">
        <ellipse cx="12.3" cy="8.4" rx="1.1" ry="1.4" />
        <ellipse cx="18.4" cy="8.3" rx="1.1" ry="1.4" />
      </g>
      <path d="M6.4 15.2c6-.7 12.1-.8 18.1-.2" strokeWidth="1.3" />
      <path d="M6.1 15.4c-.5 2.4-.7 4.8-.7 7.2M24.8 15.1c.4 2.4.7 4.8.8 7.3" strokeWidth="1.3" />
      <path d="M3.2 22.6c8.1-.9 16.3-1 24.4-.2" strokeWidth="1.3" />
      <path
        d="M2.4 22.8c.5 1.9 1.6 2.9 3.2 3 6.5.3 13 .3 19.5 0 1.6-.1 2.6-1.1 3-3"
        strokeWidth="1.3"
      />
      <path d="M12.2 24.6c1.9.2 3.8.2 5.7 0" strokeWidth="1.1" />
    </svg>
  ),

  // 4 — a wizard, because something has to explain where the apps come from.
  () => (
    <svg viewBox="0 0 32 32" aria-hidden="true" {...PEN} strokeWidth="1.5">
      <g transform="translate(0,5)">
        <Nap />
      </g>
      <path d="M6.4 8.4C8.9 5.4 11.2 2.6 13.9.2c3 2.4 5.9 5.1 8.6 7.9" strokeWidth="1.3" />
      <path d="M5.6 8.6c5.9-1.1 11.9-1.2 17.9-.2" strokeWidth="1.3" />
      <path d="M25.2 26.4 30 20.2" strokeWidth="1.4" />
      <path
        d="M29.4 15.2c.2 2 .1 4-.2 6M26.2 18.1c2.1.2 4.2.2 6.2-.1M27.3 15.9c1.5 1.5 2.9 3 4.2 4.6"
        strokeWidth="1.1"
      />
    </svg>
  ),

  // 5 — reaching for a star. It sits off to one side: drawn above his head, the two arms
  // reaching up to it landed either side of his eyes and read as a pair of angry brows.
  () => (
    <svg viewBox="0 0 34 32" aria-hidden="true" {...PEN} strokeWidth="1.5">
      <g transform="translate(0,4)">
        <Nap face="squint" />
      </g>
      <path d="M22.6 16.4c2.4-.5 4.1-1.9 5.2-4.2" strokeWidth="1.3" />
      <path
        d="M29.8 2.4c.3 2.9.2 5.8-.1 8.7M25.6 6.8c2.9.4 5.8.4 8.7-.1M26.6 3.6c2.2 2 4.2 4.1 6.1 6.4"
        strokeWidth="1.2"
      />
    </svg>
  ),

  // 6 — an idea arriving. The viewBox is taller than the drawing needs: the rays go *outside*
  // the bulb, and a box sized to the bulb clips them into stubs.
  () => (
    <svg viewBox="0 0 28 36" aria-hidden="true" {...PEN} strokeWidth="1.5">
      <g transform="translate(0,8)">
        <Nap />
      </g>
      <path
        d="M10.8 10.4C8.9 8.8 8.5 6.3 10 4.4c1.6-2 4.8-2.2 6.7-.4 1.8 1.7 1.7 4.4-.2 6.2"
        strokeWidth="1.3"
      />
      <path d="M11 11.4c1.7.4 3.5.4 5.2 0M11.8 13.4c1.2.3 2.5.3 3.7 0" strokeWidth="1.2" />
      <path d="M6.2 4.6 4.4 3.2M21 4.4l1.8-1.5M13.8 1.4V.2" strokeWidth="1.1" />
    </svg>
  ),

  // 7 — Nap in a mug, which is where he spends the mornings.
  () => (
    <svg viewBox="0 0 32 30" aria-hidden="true" {...PEN} strokeWidth="1.5">
      <path d="M9.6 14.4c-.8-2.9-.9-5.6.1-8.1C10.8 3.6 13 2.2 15.8 2.4c2.8.2 4.7 1.8 5.4 4.5.6 2.6.5 5.2-.2 7.7" />
      <g fill="currentColor" stroke="none">
        <ellipse cx="13.5" cy="8.6" rx="1" ry="1.3" />
        <ellipse cx="18.1" cy="8.5" rx="1" ry="1.3" />
      </g>
      <path d="M6.2 14.2c6.9-.9 13.9-1 20.8-.2" strokeWidth="1.3" />
      <path
        d="M7.4 14.6c.5 4.2 1.3 8.3 2.4 12.4 4.4.7 8.9.7 13.3 0 1.2-4.1 2-8.2 2.4-12.4"
        strokeWidth="1.3"
      />
      <path d="M26.4 17.4c2.3-.6 3.9.3 4 2.2.1 1.9-1.3 3.1-3.6 2.9" strokeWidth="1.2" />
    </svg>
  ),

  // 8 — waving, one paw up. A blunt hook, not a hand: he has no fingers. The first version was
  // three strokes floating beside him, which read as a speech burst rather than as an arm.
  () => (
    <svg viewBox="0 0 34 28" aria-hidden="true" {...PEN} strokeWidth="1.5">
      <Nap face="squint" />
      <path d="M22.2 13.2c1.5-1.6 3.1-2 4.3-1 1.1.9.9 2.5-.5 3.6" strokeWidth="1.4" />
      <path d="M28.4 8.8c1.1.4 2 1.1 2.6 2.1M29.2 5.4c1-.5 2.1-.8 3.2-.8" strokeWidth="1.1" />
    </svg>
  ),

  // 9 — peeking over a line, the way he waits in the preview pane.
  () => (
    <svg viewBox="0 0 30 20" aria-hidden="true" {...PEN} strokeWidth="1.5">
      <path d="M7.8 15.4c-.9-3.4-1-6.7 0-9.6C8.9 2.6 11.6.9 15.2 1c3.6.1 6.1 2 6.9 5.3.7 3 .6 6.1-.1 9.1" />
      <g fill="currentColor" stroke="none">
        <ellipse cx="12.4" cy="8.6" rx="1.1" ry="1.4" />
        <ellipse cx="18.2" cy="8.5" rx="1.1" ry="1.4" />
      </g>
      <path d="M2.4 15.6c8.4-1.1 17-1.2 25.4-.2" strokeWidth="1.4" />
      <path d="M9.4 14.6c-.9-.1-1.6.2-2 1M20.2 14.4c.9 0 1.5.4 1.9 1.2" strokeWidth="1.2" />
    </svg>
  ),

  // 10 — in a rocket, going to production. It was a paper plane first, and a plane drawn small
  // enough to sit beside him came out as a folded scribble; a capsule with a window in it reads
  // at any size, and the window is where he goes.
  () => (
    <svg viewBox="0 0 26 34" aria-hidden="true" {...PEN} strokeWidth="1.4">
      <path d="M13.2 2.2c3.4 3.5 5.2 7.8 5.3 12.8.1 2.5-.2 5-.8 7.4-3.1.8-6.3.8-9.4 0-.6-2.4-.9-4.9-.8-7.4.1-5 1.9-9.3 5.3-12.8Z" />
      <path
        d="M7.8 14.8C5.6 16.2 4.2 18.1 3.6 20.6c1.4-.2 2.7-.7 4-1.4M18.6 14.6c2.2 1.4 3.6 3.4 4.2 5.9-1.4-.2-2.8-.6-4.1-1.3"
        strokeWidth="1.2"
      />
      <path d="M10.6 23.4c.7 2.4 1.6 4.8 2.6 7.1 1-2.3 1.8-4.7 2.5-7.1" strokeWidth="1.2" />
      <path
        d="M13.1 7.6c2.3 0 3.9 1.6 3.9 3.9s-1.6 3.9-3.9 3.9-3.9-1.6-3.9-3.9 1.6-3.9 3.9-3.9Z"
        strokeWidth="1.2"
      />
      <g fill="currentColor" stroke="none">
        <ellipse cx="11.8" cy="11.2" rx="0.8" ry="1" />
        <ellipse cx="14.5" cy="11.2" rx="0.8" ry="1" />
      </g>
    </svg>
  ),

  // 11 — a heart, for the project that finally built. Beside him rather than over him: drawn
  // above the dome it sat on his head and read as a hair bun.
  () => (
    <svg viewBox="0 0 34 28" aria-hidden="true" {...PEN} strokeWidth="1.5">
      <Nap face="shut" />
      <path
        d="M28.4 14.2c-2.8-2-4.7-3.7-5-5.6-.3-1.8 1-3.1 2.6-2.9 1.1.1 1.8.9 2.1 1.9.3-1 1-1.8 2.1-1.9 1.6-.1 2.9 1.3 2.5 3.1-.4 1.9-2.4 3.5-4.3 5.4Z"
        strokeWidth="1.2"
      />
    </svg>
  ),

  // 12 — a window, roughed in. Three content lines of three lengths.
  () => (
    <svg viewBox="0 0 34 28" aria-hidden="true" {...PEN} strokeWidth="1.4">
      <path d="M3.6 4.2c-.6 6.4-.8 12.8-.4 19.2" />
      <path d="M2.4 3.4c9.8-1 19.7-1.3 29.6-.8" />
      <path d="M31.8 2.2c.6 6.8.7 13.6.4 20.4" />
      <path d="M32.4 22.8c-9.9 1.1-19.9 1.3-29.8.6" />
      <path d="M2.8 9.4c9.9-.7 19.8-.9 29.7-.5" />
      <path
        d="M6.4 6.2c.3.4.4 1 .1 1.3M10 6c.4.4.4 1 .1 1.4M13.6 6c.4.4.4 1 0 1.3"
        strokeWidth="1.2"
      />
      <path d="M7.2 14.2c6.4-.6 12.9-.7 19.3-.4M7 18.4c4.2-.4 8.4-.5 12.6-.3" strokeWidth="1.2" />
    </svg>
  ),

  // 13 — a prompt waiting for a command; the chevron's strokes cross past their meeting.
  () => (
    <svg viewBox="0 0 30 18" aria-hidden="true" {...PEN} strokeWidth="1.6">
      <path d="M4.2 3.4c2.4 2 4.6 4.2 6.7 6.5" />
      <path d="M11.6 8.6c-2.4 2.4-5 4.6-7.6 6.7" />
      <path d="M15.4 14.6c4.2-.6 8.5-.7 12.8-.4" />
    </svg>
  ),

  // 14 — braces. Code, without drawing any.
  () => (
    <svg viewBox="0 0 24 30" aria-hidden="true" {...PEN} strokeWidth="1.5">
      <path d="M8.6 3.4c-2.9.6-3.6 2.1-3.4 4.6.2 3-.6 5.1-2.8 6 2.3.9 2.9 3.1 2.7 6.1-.2 2.5.6 4 3.5 4.5" />
      <path d="M15.6 3.2c2.9.7 3.5 2.2 3.2 4.7-.3 3 .5 5 2.8 5.9-2.2 1-2.8 3.2-2.5 6.2.2 2.5-.5 4-3.4 4.4" />
    </svg>
  ),

  // 15 — a cursor just after a click. The outline breaks; the ticks are three lengths.
  () => (
    <svg viewBox="0 0 26 30" aria-hidden="true" {...PEN} strokeWidth="1.4">
      <path d="M6.4 5.2c4.3 3.6 8.4 7.4 12.4 11.4-2 .4-4 .8-6.1 1 1.3 2.2 2.4 4.5 3.4 6.9-.9.5-1.8.9-2.8 1.2-1.1-2.3-2.3-4.6-3.6-6.8-1.6 1.3-3.1 2.7-4.5 4.2-.3-6-.2-12 .4-17.9" />
      <path d="M21.8 6.6c1-.9 1.9-1.9 2.8-2.9M22 11.2c1.3-.3 2.6-.5 3.9-.6" strokeWidth="1.2" />
    </svg>
  ),

  // 16 — a spark: three crossing strokes, not a closed four-pointed star.
  () => (
    <svg viewBox="0 0 24 24" aria-hidden="true" {...PEN} strokeWidth="1.5">
      <path d="M11.8 2.4c.4 6.4.3 12.8-.4 19.2" />
      <path d="M2.6 11.6c6 .7 12 .8 18 .4" />
      <path d="M5.4 5.6c4.1 4.2 8.4 8.2 12.9 12" strokeWidth="1.3" />
    </svg>
  ),

  // 17 — a branch and a merge. The nodes are what make it legible: as two bare curves it read
  // as a hook somebody had drawn by accident.
  () => (
    <svg viewBox="0 0 26 32" aria-hidden="true" {...PEN} strokeWidth="1.4">
      <path d="M8.4 7.4c-.5 5.6-.6 11.2-.2 16.8" />
      <path d="M8.6 12.4c5.1.5 7.9 2.8 8.3 7 .1 1.1.1 2.2 0 3.3" />
      <path
        d="M8.3 3c2 0 3.2 1.2 3.2 3.1S10.3 9.3 8.3 9.3 5.1 8 5.2 6.1C5.2 4.2 6.4 3 8.3 3Z"
        strokeWidth="1.2"
      />
      <path
        d="M8.5 22.6c2 0 3.2 1.2 3.2 3.1s-1.2 3.2-3.2 3.2-3.2-1.3-3.1-3.2c0-1.9 1.2-3.1 3.1-3.1Z"
        strokeWidth="1.2"
      />
      <path
        d="M17 22.4c2 0 3.2 1.2 3.2 3.1s-1.2 3.2-3.2 3.2-3.2-1.3-3.1-3.2c0-1.9 1.2-3.1 3.1-3.1Z"
        strokeWidth="1.2"
      />
    </svg>
  ),

  // 18 — a stack, leaning. The sheets are not parallel and the gaps are not equal.
  () => (
    <svg viewBox="0 0 32 26" aria-hidden="true" {...PEN} strokeWidth="1.4">
      <path d="M2.6 8.6c4.3-2.1 8.7-4 13.2-5.6" />
      <path d="M14.9 2.8c4.1 1.6 8.1 3.3 12 5.3" />
      <path d="M27.3 7.7c-4 2.1-8.2 4-12.4 5.6" />
      <path d="M15.6 13.6c-4.3-1.5-8.5-3.3-12.6-5.3" />
      <path d="M2.9 13.1c3.7 2.1 7.7 3.9 11.7 5.4 4.1-1.4 8.1-3.2 11.9-5.4" strokeWidth="1.2" />
      <path d="M3.6 17.9c3.6 2.2 7.4 4 11.4 5.5 4-1.7 7.9-3.7 11.6-6" strokeWidth="1.2" />
    </svg>
  ),

  // 19 — a cloud, because everything here runs on somebody else's computer.
  () => (
    <svg viewBox="0 0 32 20" aria-hidden="true" {...PEN} strokeWidth="1.4">
      <path d="M7.6 16.4c-3.2.2-5.2-1.4-5.2-4 0-2.4 1.7-3.9 4.4-3.9.2-3.4 2.6-5.6 6.1-5.6 3 0 5.2 1.6 6 4.2 3.7-.7 6.3 1 6.7 4 .4 3.1-1.8 5.3-5.6 5.4" />
      <path d="M8 16.4c4.1.4 8.2.4 12.3.1" strokeWidth="1.2" />
    </svg>
  ),

  // 20 — a bug, found and squashed later.
  () => (
    <svg viewBox="0 0 26 26" aria-hidden="true" {...PEN} strokeWidth="1.4">
      <path d="M6.8 12.4c-.4-4 1.9-6.6 5.8-6.7 4-.1 6.4 2.4 6.2 6.4-.2 4.4-2.4 7-6.1 7-3.6 0-5.7-2.4-5.9-6.7Z" />
      <path d="M9.4 6.4 7.6 3.2M15.6 6.2l2.1-3.1" strokeWidth="1.1" />
      <path
        d="M6.6 10.2 3.2 8.8M6.8 14.4l-3.6.8M19 10.1l3.4-1.6M18.8 14.3l3.5.9"
        strokeWidth="1.1"
      />
      <path d="M12.8 6.2c.3 4.2.3 8.4 0 12.6" strokeWidth="1.1" />
    </svg>
  ),
];

/**
 * Where the drawings go.
 *
 * A jittered grid rather than a written-out list of positions: at this density the list would be
 * two hundred lines of numbers nobody could adjust, and the interesting part — that no two
 * neighbours share a size, an angle or a subject — is a rule, not a set of coordinates.
 *
 * **The jitter is a hash of the cell, not a random number.** `Math.random()` here would place the
 * sheet one way on the server and another in the browser; React calls that a hydration mismatch,
 * throws the server's markup away and fills the console with it. This is a plain integer hash, so
 * both renders agree and the page looks the same on every reload.
 *
 * Cells inside the two clearings are dropped rather than drawn and masked away — the mask hides
 * them either way, and this is fifty fewer drawings for the browser to lay out.
 */
type Placed = { seed: number; x: number; y: number; rotate: number; size: number; doodle: number };

const COLUMNS = 13;
const ROWS = 13;

/** The form's clearing, as fractions of the page — kept in step with `.nap-doodle-wall`. */
const CLEARING = { x: 0.5, y: 0.49, rx: 0.26, ry: 0.3 };
/** And the wordmark's, in the top-left corner where it sits. */
const LOGO = { x: 0.045, y: 0.045, rx: 0.13, ry: 0.09 };

/**
 * Deterministic, cheap, and good enough to look unplanned: an integer hash spread over 0…1.
 *
 * **Integer operations, deliberately.** The obvious one-liner for this is
 * `Math.sin(seed * 127.1) * 43758.5453` — and it hydrates *wrong*. The precision of `Math.sin`
 * is implementation-defined, the server runs on Bun's JavaScriptCore and the browser on V8, and
 * the two disagree in the last bits: the sheet is laid out one way in the HTML and another in
 * the browser, and React throws the server's markup away. `Math.imul`, xor and shift are exactly
 * specified, so both sides get the same number. This was not theoretical; it happened here.
 */
function jitter(seed: number): number {
  let hash = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  hash ^= hash >>> 16;
  return (hash >>> 0) / 4_294_967_296;
}

function inside(area: { x: number; y: number; rx: number; ry: number }, x: number, y: number) {
  const dx = (x - area.x) / area.rx;
  const dy = (y - area.y) / area.ry;
  return dx * dx + dy * dy < 1;
}

function buildWall(): Placed[] {
  const placed: Placed[] = [];

  for (let row = 0; row < ROWS; row += 1) {
    for (let column = 0; column < COLUMNS; column += 1) {
      const seed = row * COLUMNS + column;
      // Odd rows start half a cell in, so the columns never line up into visible streets.
      const offset = row % 2 === 0 ? 0 : 0.5;
      const x = ((column + offset + 0.5) / COLUMNS + (jitter(seed) - 0.5) * 0.05) * 100;
      const y = ((row + 0.5) / ROWS + (jitter(seed + 97) - 0.5) * 0.05) * 100;
      if (x < -2 || x > 102) continue;
      if (inside(CLEARING, x / 100, y / 100)) continue;
      if (inside(LOGO, x / 100, y / 100)) continue;

      placed.push({
        // The cell this came out of: a stable key that is not the array index.
        seed,
        x,
        y,
        rotate: Math.round((jitter(seed + 211) - 0.5) * 30),
        size: Math.round(30 + jitter(seed + 419) * 20),
        // The step has to be **coprime with the number of drawings** or it walks a subset and
        // stops: at 21 drawings a step of 7 visits three of them and the wall came out as the
        // same handful of ghosts over and over, which reads as a tiled background rather than as
        // a sheet somebody filled in.
        doodle: (seed * 8 + Math.floor(jitter(seed + 613) * 5)) % DOODLES.length,
      });
    }
  }

  return placed;
}

/** Built once at module load: it is the same sheet on every render and on both sides. */
const WALL = buildWall();

export function DoodleWall() {
  return (
    <div
      aria-hidden="true"
      data-testid="doodle-wall"
      className="nap-doodle-wall pointer-events-none absolute inset-0 hidden overflow-hidden text-[var(--s-doodle)] sm:block"
    >
      {WALL.map(({ seed, x, y, rotate, size, doodle }) => {
        const Drawing = DOODLES[doodle];
        if (Drawing === undefined) return null;
        return (
          <div
            // The cell, not the array index: the same drawing appears many times over, so the
            // drawing's own number is not unique.
            key={seed}
            className="absolute"
            style={{
              left: `${x}%`,
              top: `${y}%`,
              width: size,
              transform: `translate(-50%, -50%) rotate(${rotate}deg)`,
            }}
          >
            <Drawing />
          </div>
        );
      })}
    </div>
  );
}
