"use client";

import { useEffect } from "react";

/**
 * Holds the window still for as long as the caller is mounted.
 *
 * The app shells are fixed-viewport frames: the height is pinned, and scrolling belongs to named
 * regions inside them — the projects column, the transcript, the file tree, the viewer, the
 * preview frame. A clamp on each of those frames is not enough to guarantee that, because
 * **`overflow: hidden` only clips descendants it is the containing block for**. An absolutely
 * positioned element inside a *static* clipping box has the initial containing block instead, so
 * it escapes the clip entirely and stretches the document — which is how a screen-reader-only
 * label at the bottom of a list came to scroll the whole page, header and all. The boxes are
 * positioned now so that cannot happen; this is what makes a future one clip rather than scroll.
 *
 * Applied per shell rather than as a `body` rule in the stylesheet: the landing, sign-in and
 * welcome pages are deliberately full-length scrolling documents, and a global rule would break
 * all three.
 *
 * Both elements are clamped because which of them owns the viewport's scrollbar is decided by the
 * overflow propagation rules rather than by the markup — the root takes it unless the body has
 * said otherwise. Whatever was on them inline is restored on the way out, so leaving a shell for
 * a page that *is* a document cannot leave that page unable to scroll.
 */
export function useDocumentScrollLock(): void {
  useEffect(() => {
    const root = document.documentElement;
    const { body } = document;
    const previousRoot = root.style.overflow;
    const previousBody = body.style.overflow;

    root.style.overflow = "hidden";
    body.style.overflow = "hidden";

    return () => {
      root.style.overflow = previousRoot;
      body.style.overflow = previousBody;
    };
  }, []);
}
