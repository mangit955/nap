/**
 * The mark's geometry, in one place.
 *
 * It lives apart from the component because the same drawing has to exist twice — once as JSX
 * and once as `app/icon.svg`, which the framework serves as a tab icon and which therefore
 * cannot import anything. These constants are what the component uses and what the favicon is
 * generated from, and a test pins the file to them so the two cannot drift apart unnoticed.
 *
 * A 24×24 grid, so the numbers stay readable and the mark lands on whole pixels at 24px.
 *
 * **The proportions are doing the work, and they were chosen by looking.** The first version was
 * a tall ghost with small features set close together, which read as flat and was illegible at
 * 24px — the features were sub-pixel. This one is nearly as wide as it is tall, and the eyes are
 * large, low and wide apart: that combination is what reads as a character rather than as a
 * pictogram, and it is also what survives being shrunk into a header.
 */

/**
 * The body: a wide dome, short shoulders, and a hem of three deep bumps. The silhouette is the
 * whole identity of the mark, because at 16px in a browser tab it is the only thing left.
 */
export const NAP_BODY =
  "M2.2 11.6a9.8 9.8 0 0 1 19.6 0v6.1c0 1.8-2.1 2.8-3.5 1.6l-1.3-1.1c-.7-.6-1.7-.5-2.4.2l-.8.8c-.8.8-2 .8-2.8 0l-.8-.8c-.7-.7-1.7-.8-2.4-.2l-1.3 1.1c-1.4 1.2-3.5.2-3.5-1.6Z";

/**
 * Closed eyes: two crescents curving downward. This is the resting state and the one the
 * favicon is drawn in — the product is called nap, and dots would read as awake.
 *
 * They are thick for their size on purpose. A finer line is prettier at 96px and disappears
 * entirely at 24px, which is where this mark actually lives.
 */
export const NAP_EYE_SHUT_LEFT =
  "M6.5 11.9c.44 1.7 1.2 2.7 2.1 2.7s1.66-1 2.1-2.7c.14-.53-.66-.76-.82-.24-.32 1.16-.76 1.79-1.28 1.79s-.96-.63-1.28-1.79c-.16-.52-.96-.29-.82.24Z";

export const NAP_EYE_SHUT_RIGHT =
  "M13.3 11.9c.44 1.7 1.2 2.7 2.1 2.7s1.66-1 2.1-2.7c.14-.53-.66-.76-.82-.24-.32 1.16-.76 1.79-1.28 1.79s-.96-.63-1.28-1.79c-.16-.52-.96-.29-.82.24Z";

/**
 * Open eyes, on the same centres as the crescents so waking does not move the face. Taller than
 * they are wide, because a circle reads as a stare and an oval reads as attention.
 */
export const NAP_EYE_OPEN = [
  { cx: 8.6, cy: 12.4 },
  { cx: 15.4, cy: 12.4 },
] as const;

export const NAP_EYE_OPEN_RX = 1.35;
export const NAP_EYE_OPEN_RY = 1.7;

/**
 * A mouth, barely there: one small oval under the eyes. It is the cheapest possible charm — at
 * 24px it is two pixels — and it is what stops the face reading as a pair of holes.
 *
 * Cheeks were tried here too and thrown out: knocked out of a filled body they become two more
 * light spots, and at 24px a viewer counts four eyes.
 */
export const NAP_MOUTH = { cx: 12, cy: 16.2, rx: 0.62, ry: 0.5 } as const;
