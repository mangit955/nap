/**
 * The mark: a ghost, asleep.
 *
 * A solid silhouette rather than an outline, because the mark has to survive at 16px in a
 * browser tab — a monoline drawing at that size turns into four grey pixels, while a filled
 * shape keeps its silhouette all the way down. Everything that identifies it is therefore in
 * the *outline* of the body: the dome, the straight shoulders, the three-bump hem.
 *
 * **The eyes are knocked out of the fill, not drawn on top of it.** One path with
 * `fill-rule="evenodd"` means there is exactly one colour in the mark and it is whatever the
 * surrounding text is — so it works on the light stage, in the dark workspace header, and as a
 * one-colour favicon, with nothing to keep in step. Drawing the eyes in the background colour
 * would have been easier and would break the moment the surface behind it changed.
 *
 * Asleep is carried by two closed crescents curving *downward*. It is the whole idea of the
 * product in the one feature a face has room for at this size, and it is why the eyes are
 * crescents rather than dots: dots read as awake, and an awake ghost is just a ghost.
 *
 * It takes no props beyond the usual svg ones and sets no size of its own — the caller sizes it,
 * so it can be a 16px tab icon and a 96px sign-in mark from the same file.
 */

import type { SVGProps } from "react";

export function NapMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M2.8 11.4a9.2 9.2 0 0 1 18.4 0v7.4c0 1.5-1.7 2.3-2.9 1.4l-1.5-1.2c-.6-.5-1.5-.4-2.1.1l-1.1 1c-.6.6-1.6.6-2.2 0l-1.1-1c-.6-.5-1.5-.6-2.1-.1l-1.5 1.2c-1.2.9-2.9.1-2.9-1.4Zm4.9-.5c.35 1.35.95 2.15 1.7 2.15s1.35-.8 1.7-2.15c.11-.42-.53-.6-.66-.19-.26.94-.62 1.44-1.04 1.44s-.78-.5-1.04-1.44c-.13-.41-.77-.23-.66.19Zm5.2 0c.35 1.35.95 2.15 1.7 2.15s1.35-.8 1.7-2.15c.11-.42-.53-.6-.66-.19-.26.94-.62 1.44-1.04 1.44s-.78-.5-1.04-1.44c-.13-.41-.77-.23-.66.19Z"
      />
    </svg>
  );
}
