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
 * Squinting: two chevrons pointing in at each other, the face of somebody enjoying themselves
 * with their eyes shut. Same centres again, so nothing on the face moves between the three
 * states — only which one is visible.
 *
 * These are strokes rather than filled wedges. Filled, a chevron this small closes up into a
 * triangle at any size the mark is actually used at; as a thick round-capped line it keeps the
 * gap in the middle, which is the entire shape.
 */
export const NAP_EYE_SQUINT_LEFT = "M7.4 10.7 9.6 12.4 7.4 14.1";
export const NAP_EYE_SQUINT_RIGHT = "M16.6 10.7 14.4 12.4 16.6 14.1";

/** As thick as the closed lids, and for the same reason: a finer line vanishes at 24px. */
export const NAP_EYE_SQUINT_WEIGHT = 1.25;

/**
 * The z's that drift off it while it sleeps, drawn as strokes rather than filled letterforms —
 * a filled `z` at this size is a blob, while a three-segment zigzag survives being four pixels
 * tall.
 *
 * They live *outside* the ghost, up and to its right, which is why the component's viewBox is
 * larger than this 24-grid: the room above the shoulder is where they rise into. Sizes grow as
 * they travel, because the ones further away have been drifting longer.
 */
/*
 * Three fixed stations rather than three z's each travelling the whole way up. The rise comes
 * from the *sequence* — one fades in at each station in turn — so no single z has to cross the
 * box. The first attempt did have them travel, and the top one flew straight out through the
 * viewBox and was clipped into a horizontal bar for the last third of its life.
 */
export const NAP_ZS = [
  { x: 20.2, y: 2.4, size: 2.4, weight: 0.85 },
  { x: 22.4, y: -0.8, size: 2.9, weight: 0.95 },
  { x: 24.6, y: -3.6, size: 3.4, weight: 1.05 },
] as const;

/** One `z`: across, back down the diagonal, across again. */
export function zPath({ x, y, size }: { x: number; y: number; size: number }): string {
  return `M${x} ${y}h${size}l${-size} ${size}h${size}`;
}

/*
 * The face is two eyes and nothing else, and two additions have been tried and removed.
 *
 * A small mouth under the eyes: on a filled body it is a light spot in the middle of the face,
 * and at the size this mark is actually used it reads as a nose rather than a mouth.
 *
 * Cheeks: the same problem twice over — two more light spots, and at 24px a viewer counts four
 * eyes.
 *
 * The pattern is worth remembering before adding a third. Every feature here is a *hole*, not a
 * mark, so anything added to the face is read as another eye until proven otherwise.
 */
