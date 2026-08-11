"use client";

/**
 * A box with light running around its rim.
 *
 * The body carries the glow and nothing else: it is one pixel of padding around a face, and
 * **that pixel is the gap the ring lives in**. The face is inset into it and given a radius one
 * pixel smaller so the two stay concentric — a face at the same radius leaves the corners
 * looking pinched, which is the sort of thing nobody can name but everybody sees.
 *
 * The layers stay strictly *under* the face. Lifted above it, the soft inner edge of the ring
 * spills across the front of the box and washes out everything written on it.
 *
 * The hook is separate from the component because the caller needs the pulse handle — pressing
 * send is answered by light — and because a ref plus five masks is more state than a component
 * this small should own on the caller's behalf.
 */

import { type ReactNode, useRef } from "react";
import { RimGlow } from "./rim-glow.tsx";
import { useAiPulse } from "./use-pulse.ts";
import { type RimLayer, useRimMask } from "./use-rim-mask.ts";

export type Glow = {
  ref: React.RefObject<HTMLDivElement | null>;
  layers: readonly RimLayer[];
  radius: number;
  pulse: () => void;
};

export function useGlow(radius: number): Glow {
  const ref = useRef<HTMLDivElement>(null);
  const layers = useRimMask(ref, radius);
  const { pulse } = useAiPulse({ ref });

  return { ref, layers, radius, pulse };
}

export function GlowBox({
  glow,
  className = "",
  faceClassName = "",
  children,
}: {
  glow: Glow;
  /** Sizing for the body. It must not clip: the halo paints well outside it. */
  className?: string;
  faceClassName?: string;
  children: ReactNode;
}) {
  return (
    <div
      ref={glow.ref}
      className={`ai-lights relative p-px ${className}`}
      style={{ borderRadius: `${glow.radius}px` }}
    >
      <RimGlow layers={glow.layers} />

      <div
        className={`relative h-full w-full ${faceClassName}`}
        style={{ borderRadius: `${Math.max(0, glow.radius - 1)}px` }}
      >
        {children}
      </div>
    </div>
  );
}
