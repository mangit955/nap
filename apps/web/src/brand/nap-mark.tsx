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
  NAP_EYE_BORED_LEFT,
  NAP_EYE_BORED_RIGHT,
  NAP_EYE_OPEN,
  NAP_EYE_OPEN_RX,
  NAP_EYE_OPEN_RY,
  NAP_EYE_SHUT_LEFT,
  NAP_EYE_SHUT_RIGHT,
  NAP_EYE_SQUINT_LEFT,
  NAP_EYE_SQUINT_RIGHT,
  NAP_EYE_SQUINT_WEIGHT,
  NAP_ZS,
  zPath,
} from "./nap-mark-paths.ts";

export function NapMark({ className = "", ...props }: SVGProps<SVGSVGElement>) {
  // A document-unique id per instance: two marks on one page sharing a mask id would have the
  // second one silently using the first one's cut-outs. Stripped of punctuation because React's
  // ids contain colons, which are legal in an id and a nuisance everywhere else.
  const maskId = `nap-mark-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;

  return (
    <svg
      // Wider and taller than the 24-grid the ghost is drawn on, and offset so the ghost still
      // sits at the optical centre: the extra room up and to the right is where the z's rise
      // into. Growing the viewBox rather than wrapping the svg in a positioned div keeps the
      // whole mark one element that a caller can size with a single class.
      viewBox="-1 -6 32 32"
      fill="currentColor"
      aria-hidden="true"
      className={`nap-mark ${className}`}
      {...props}
    >
      <mask id={maskId}>
        {/*
          White keeps, black cuts. The body is the white; the eyes are the black. The rect has
          to cover the whole viewBox — sized to the old 24-grid it would clip the body's own
          bottom, which is the sort of thing that looks like a broken path rather than a mask.
        */}
        <rect x="-1" y="-6" width="32" height="32" fill="#fff" />
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

          {/*
            A third face, hidden unless something asks for it: eyes screwed shut in enjoyment.
            It ships with the mark rather than being drawn over the top by a caller because the
            face is *cut out* of the body — anything painted on top would have to guess the
            colour behind the ghost, which is the mistake the mask exists to avoid.
          */}
          <g
            className="nap-mark-squint"
            fill="none"
            stroke="#000"
            strokeWidth={NAP_EYE_SQUINT_WEIGHT}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d={NAP_EYE_SQUINT_LEFT} />
            <path d={NAP_EYE_SQUINT_RIGHT} />
          </g>

          {/* And a fourth: lids halfway down, for whenever he needs to look unimpressed. */}
          <g className="nap-mark-bored">
            <path d={NAP_EYE_BORED_LEFT} />
            <path d={NAP_EYE_BORED_RIGHT} />
          </g>
        </g>
      </mask>

      <path className="nap-mark-body" d={NAP_BODY} mask={`url(#${maskId})`} />

      {/*
        Each z is its own element so it can carry its own delay: one shared animation would
        move them in lockstep, which reads as a decoration blinking rather than as a stream of
        them leaving. They are outside the mask — they belong to the air, not to the ghost.
      */}
      <g
        className="nap-mark-zzz"
        fill="none"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {NAP_ZS.map((z, index) => (
          <path
            key={z.x}
            className="nap-mark-z"
            d={zPath(z)}
            strokeWidth={z.weight}
            style={{ animationDelay: `${index * 1.4}s` }}
          />
        ))}
      </g>
    </svg>
  );
}
