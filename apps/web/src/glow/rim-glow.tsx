"use client";

import type { RimLayer } from "./use-rim-mask.ts";

/**
 * The light itself: one coloured span per layer, each masked to a soft band around the box.
 *
 * **Every layer is drawn twice**, the second copy mirrored, because the lit arc of the mask
 * sits on one side — one copy alone lights the right-hand edge and leaves the left permanently
 * dark, which reads as a rendering fault rather than as a highlight.
 *
 * Each span is inset *negatively* by its own layer's padding, so the blurred band has room to
 * fall off outside the element instead of being clipped square at its edge.
 *
 * `aria-hidden`, and nothing more: this is colour. It has no state a label could describe.
 */
export function RimGlow({ layers }: { layers: readonly RimLayer[] }) {
  return (
    <>
      {layers.map((layer) =>
        [0, 1].map((mirrored) => (
          <span
            key={`${layer.id}-${mirrored}`}
            aria-hidden="true"
            className="ai-lights-layer"
            style={{
              inset: `${-layer.pad}px`,
              maskImage: `url(${layer.mask})`,
              WebkitMaskImage: `url(${layer.mask})`,
              transform: mirrored === 1 ? "scaleX(-1)" : undefined,
            }}
          />
        )),
      )}
    </>
  );
}
