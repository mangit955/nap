"use client";

/**
 * The mark: a ghost, asleep — until you look at it.
 *
 * A solid silhouette rather than an outline, because the mark has to survive at 16px in a
 * browser tab: a monoline drawing at that size turns into four grey pixels, while a filled
 * shape keeps its silhouette all the way down. Everything that identifies it is therefore in
 * the *outline* of the body — the dome, the straight shoulders, the three-bump hem.
 *
 * **The eyes are cut out of the body with a mask, not painted over it.** That keeps the whole
 * mark one colour, taken from the text beside it, so the same file works on the light stage, in
 * the dark workspace header and as a one-colour icon. Painting the eyes in the background
 * colour would look identical here and break the moment the surface behind it changed.
 *
 * The mask is also what makes it animatable. Cutting the eyes out of a *single* path with
 * `evenodd` — which is how this started — welds them to the body, so opening them would mean
 * swapping the entire drawing. As mask contents they are ordinary elements that can fade and
 * move while the body holds still.
 *
 * **On hover it wakes.** The lids fade out, the eyes fade in, and it glances right, then left,
 * then back — with a bob a fraction of a pixel high, because a thing that is awake is never
 * completely still. Everything is on a delay from the same beat so the wake reads as one
 * gesture rather than three. It is deliberately slow: a fast blink at this size reads as a
 * flicker, which looks like a rendering fault rather than a character.
 *
 * `aria-hidden`, because the wordmark beside it already says nap and a second copy would be
 * announced twice. It takes no props beyond the usual svg ones and sets no size of its own — the
 * caller sizes it, so one file is a 16px tab icon and a 24px header mark.
 */

import type { SVGProps } from "react";
import { useId } from "react";
import {
  NAP_BODY,
  NAP_EYE_OPEN,
  NAP_EYE_OPEN_RX,
  NAP_EYE_OPEN_RY,
  NAP_EYE_SHUT_LEFT,
  NAP_EYE_SHUT_RIGHT,
  NAP_MOUTH,
} from "./nap-mark-paths.ts";

export function NapMark({ className = "", ...props }: SVGProps<SVGSVGElement>) {
  // A document-unique id per instance: two marks on one page sharing a mask id would have the
  // second one silently using the first one's cut-outs. Stripped of punctuation because React's
  // ids contain colons, which are legal in an id and a nuisance everywhere else.
  const maskId = `nap-mark-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={`nap-mark ${className}`}
      {...props}
    >
      <mask id={maskId}>
        {/* White keeps, black cuts. The body is the white; the eyes are the black. */}
        <rect width="24" height="24" fill="#fff" />
        <g className="nap-mark-eyes" fill="#000">
          <g className="nap-mark-shut">
            <path d={NAP_EYE_SHUT_LEFT} />
            <path d={NAP_EYE_SHUT_RIGHT} />
          </g>
          <g className="nap-mark-open">
            {NAP_EYE_OPEN.map((eye) => (
              <ellipse
                key={eye.cx}
                cx={eye.cx}
                cy={eye.cy}
                rx={NAP_EYE_OPEN_RX}
                ry={NAP_EYE_OPEN_RY}
              />
            ))}
          </g>
        </g>

        {/* Outside the eye group, so it stays put while the eyes glance around it. */}
        <ellipse
          cx={NAP_MOUTH.cx}
          cy={NAP_MOUTH.cy}
          rx={NAP_MOUTH.rx}
          ry={NAP_MOUTH.ry}
          fill="#000"
        />
      </mask>

      <path className="nap-mark-body" d={NAP_BODY} mask={`url(#${maskId})`} />
    </svg>
  );
}
