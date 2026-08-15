/**
 * The sizes a browser check may run at, as three names rather than as numbers.
 *
 * Named sizes, not arbitrary pixels, because a viewport in a task is a claim about a class of
 * device — "this works on a phone" — and two tasks that each invented their own idea of a
 * phone would produce results nobody could compare. The numbers live here once; a task says
 * `mobile`.
 *
 * Viewport is a field on a browser check rather than a check kind of its own, so the same
 * interaction sequence can be asserted at any size without being written twice. See the
 * specification's implementation decisions, and `CONTEXT.md` for the vocabulary.
 */

import { z } from "zod";

export const VIEWPORT_NAMES = ["mobile", "tablet", "desktop"] as const;

export const ViewportNameSchema = z.enum(VIEWPORT_NAMES);
export type ViewportName = z.infer<typeof ViewportNameSchema>;

export type ViewportSize = { width: number; height: number };

/**
 * Concrete sizes. Mobile is 375×667 because it is the narrowest width still worth designing
 * for, and the width horizontal-overflow assertions are really about.
 */
export const VIEWPORT_SIZES = {
  mobile: { width: 375, height: 667 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1280, height: 800 },
} as const satisfies Record<ViewportName, ViewportSize>;

/**
 * What a check runs at when it does not say.
 *
 * Desktop, because a check that forgot to declare a viewport is a check about behaviour
 * rather than layout, and behaviour is cheapest to observe where nothing is collapsed behind
 * a menu.
 */
export const DEFAULT_VIEWPORT_NAME: ViewportName = "desktop";

export function viewportSize(name: ViewportName): ViewportSize {
  return VIEWPORT_SIZES[name];
}

/**
 * Which named size a measured one is, or undefined for a size that is none of them.
 *
 * The inverse direction exists because a screenshot comes back from the browser as two numbers:
 * the page is the only thing that knows what size a check *ended* at, since a check may resize
 * partway through, and a stored image is compared across runs by name. Undefined rather than a
 * guess when nothing matches — a capture labelled `mobile` at 800px wide would be worse than one
 * whose name had to be taken from what the check asked for.
 */
export function viewportNameForSize(size: ViewportSize): ViewportName | undefined {
  return VIEWPORT_NAMES.find(
    (name) =>
      VIEWPORT_SIZES[name].width === size.width && VIEWPORT_SIZES[name].height === size.height,
  );
}
