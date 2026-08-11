"use client";

/**
 * A box that holds its shape, with the same pulse of light running its rim.
 *
 * `MorphCard` is a *picture* of software working, for somebody who has not signed in yet and has
 * nothing of their own to look at. Once there is an account, the thing worth lighting is the box
 * they actually type into — so the light moves onto it and the picture goes away. A page cannot
 * have two of these: the pulse is what makes the rest of the page look lit, and two of them
 * would be two arcs beating out of step in the same room.
 *
 * Everything the morph card does *about changing shape* is gone, and with it the reason its
 * timeline is so carefully ordered. What is left is the part that was never about morphing: roll
 * a palette, run the light once, wait. The mask is a raster sized to one box, and this box only
 * changes size when the window does — which `useRimMask` already debounces.
 *
 * It is not `aria-hidden`, unlike the card. There is a real control inside it.
 */

import { type ReactNode, type RefObject, useRef } from "react";
import { RimGlow } from "./rim-glow.tsx";
import { useAiPulse } from "./use-pulse.ts";
import { useRimMask } from "./use-rim-mask.ts";

/** Must match the `ai-pulse` keyframes in `globals.css`. */
const PULSE_MS = 1600;

/**
 * Longer than the card's dark time, and chosen rather than derived: the card's gap is whatever
 * its handover needs, while nothing here has to fit inside this one. What sets it is that this
 * box is a place somebody is *typing* — a light that came round every couple of seconds beside a
 * cursor would be something to look away from rather than atmosphere.
 */
const GAP_MS = 3400;

export function LitBox({
  paletteRef,
  radius = 20,
  faceClassName = "",
  children,
}: {
  /**
   * The element the palette is written to — the stage, not this box. Custom properties inherit,
   * so one roll colours the rim *and* the surface it stands on; rolling onto the box itself
   * leaves the stage on its initial colour forever, silently.
   */
  paletteRef: RefObject<HTMLElement | null>;
  radius?: number;
  faceClassName?: string;
  children: ReactNode;
}) {
  const body = useRef<HTMLDivElement>(null);
  const layers = useRimMask(body, radius);

  useAiPulse({ ref: body, paletteRef, pulseMs: PULSE_MS, gapMs: GAP_MS });

  return (
    <div
      ref={body}
      // The one pixel of padding *is* the gap the ring lives in; the face's radius is one less so
      // the two stay concentric.
      className="ai-lights relative w-full p-px"
      style={{ borderRadius: `${radius}px` }}
    >
      <RimGlow layers={layers} />

      <div
        className={`relative ${faceClassName}`}
        style={{ borderRadius: `${Math.max(0, radius - 1)}px` }}
      >
        {children}
      </div>
    </div>
  );
}
