/**
 * The mark's geometry, in one place.
 *
 * It lives apart from the component because the same drawing has to exist twice — once as JSX
 * and once as `app/icon.svg`, which the framework serves as a tab icon and which therefore
 * cannot import anything. These constants are what the component uses and what the favicon is
 * generated from, and a test pins the file to them so the two cannot drift apart unnoticed.
 *
 * A 24×24 grid, so the numbers stay readable and the mark lands on whole pixels at 24px.
 */

/**
 * The body: a dome, straight shoulders, and a hem of three bumps. The silhouette is the whole
 * identity of the mark, because at 16px in a browser tab it is the only thing left.
 */
export const NAP_BODY =
  "M2.8 11.4a9.2 9.2 0 0 1 18.4 0v7.4c0 1.5-1.7 2.3-2.9 1.4l-1.5-1.2c-.6-.5-1.5-.4-2.1.1l-1.1 1c-.6.6-1.6.6-2.2 0l-1.1-1c-.6-.5-1.5-.6-2.1-.1l-1.5 1.2c-1.2.9-2.9.1-2.9-1.4Z";

/**
 * Closed eyes: two crescents curving downward. This is the resting state and the one the
 * favicon is drawn in — the product is called nap, and dots would read as awake.
 */
export const NAP_EYE_SHUT_LEFT =
  "M7.7 10.9c.35 1.35.95 2.15 1.7 2.15s1.35-.8 1.7-2.15c.11-.42-.53-.6-.66-.19-.26.94-.62 1.44-1.04 1.44s-.78-.5-1.04-1.44c-.13-.41-.77-.23-.66.19Z";

export const NAP_EYE_SHUT_RIGHT =
  "M12.9 10.9c.35 1.35.95 2.15 1.7 2.15s1.35-.8 1.7-2.15c.11-.42-.53-.6-.66-.19-.26.94-.62 1.44-1.04 1.44s-.78-.5-1.04-1.44c-.13-.41-.77-.23-.66.19Z";

/**
 * Open eyes, on the same centres as the crescents so waking does not move the face. Taller than
 * they are wide, because a circle reads as a stare and an oval reads as attention.
 */
export const NAP_EYE_OPEN = [
  { cx: 9.4, cy: 11.5 },
  { cx: 14.6, cy: 11.5 },
] as const;

export const NAP_EYE_OPEN_RX = 1;
export const NAP_EYE_OPEN_RY = 1.3;
