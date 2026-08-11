"use client";

/**
 * Builds the five mask PNGs for whatever box an element currently occupies.
 *
 * A mask is a raster sized to one specific box, so it cannot be interpolated — every change of
 * shape means drawing all five again and calling `toDataURL` five times. That is affordable
 * here only because the box holds still: the rebuild is debounced until a resize has settled,
 * and in the meantime `mask-size: 100% 100%` stretches the old one, which is imperceptible
 * across the few frames a window resize takes.
 *
 * Nothing renders while the element has no box — during server rendering, and in jsdom, that
 * is always — so the box appears unlit rather than not at all.
 */

import { type RefObject, useEffect, useState } from "react";
import { buildMask, padOf, RIM_LAYERS, RIM_STOPS } from "./mask.ts";

/** `id` is the layer's place in the falloff — its stroke and blur, which no two layers share. */
export type RimLayer = { id: string; mask: string; pad: number };

/** How long a resize has to be over before the masks are redrawn. */
const SETTLE_MS = 90;

export function useRimMask(
  ref: RefObject<HTMLElement | null>,
  radius: number,
  settleMs: number = SETTLE_MS,
): RimLayer[] {
  const [layers, setLayers] = useState<RimLayer[]>([]);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;

    const build = () => {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return;

      setLayers(
        RIM_LAYERS.map((layer) => ({
          id: `${layer.strokeWidth}-${layer.blur}`,
          mask: buildMask({
            width: box.width,
            height: box.height,
            radius,
            strokeWidth: layer.strokeWidth,
            blur: layer.blur,
            alpha: layer.alpha,
            ring: layer.ring,
            stops: RIM_STOPS,
          }),
          pad: padOf(layer.strokeWidth, layer.blur),
        })).filter((layer) => layer.mask !== ""),
      );
    };

    build();

    let settle: number | null = null;
    const observer = new ResizeObserver(() => {
      if (settle !== null) window.clearTimeout(settle);
      settle = window.setTimeout(build, settleMs);
    });
    observer.observe(element);

    return () => {
      if (settle !== null) window.clearTimeout(settle);
      observer.disconnect();
    };
  }, [ref, radius, settleMs]);

  return layers;
}
