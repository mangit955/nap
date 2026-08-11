"use client";

/**
 * One body that becomes four different surfaces, lit by a pulse of light running its rim.
 *
 * There is a **single element** for the life of the card. It carries the glow, and it animates
 * its width, height and corner radius from one shape to the next — so a workflow node becomes a
 * progress row becomes a terminal becomes a bar as one object changing its mind, rather than
 * four objects taking turns.
 *
 * **The timeline is three beats that never overlap, and their order is the single most
 * important decision in the whole effect:**
 *
 *   1. the light pulses once;
 *   2. the contents fade out while the body is still the old shape;
 *   3. the empty body morphs, and only once it has settled do the new contents rise in.
 *
 * Morphing in the dark is what makes this affordable. The mask is a raster sized to one
 * specific box and cannot be interpolated, so light travelling a changing edge would mean all
 * five layers redrawn every frame — hundreds of canvas draws per morph. Sequenced this way the
 * glow has already gone by the time the box moves, and the mask only has to be right again once
 * it stops: one rebuild, debounced until the shape settles, with the old mask stretched over the
 * new box in the meantime, where nobody can see it.
 *
 * The morph is kept short. Width, height and radius are layout-and-paint properties the
 * compositor cannot take, so every frame runs on the main thread; a long morph is simply a
 * longer stretch of expensive frames with more room for jank to show. It eases *out* rather
 * than in-out, so the box leaves fast and settles slowly — an in-out curve spends its slowest
 * frames in the middle of the morph, which is exactly where the shape means least.
 *
 * **It is ornamental, and it is `aria-hidden` rather than labelled.** It changes what it is
 * every few seconds; a label never re-announces, so any name it carried would be wrong within
 * seconds of being read, and its per-character spans would be spelled out letter by letter.
 * Nothing here is interactive: it is a picture of software working, and the controls that do
 * something sit beneath it.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { RimGlow } from "./rim-glow.tsx";
import { useAiPulse } from "./use-pulse.ts";
import { useRimMask } from "./use-rim-mask.ts";
import { DARK_KEYS, radiusFor, useVariantSizes, VARIANTS, variantAt } from "./variants.tsx";

const PULSE_MS = 1600;
/** Contents leave before the shape does, and they leave quickly. */
const FADE_OUT_MS = 160;
const MORPH_MS = 380;
/** The handover starts just after the light has finished, never during it. */
const HANDOVER_AT = PULSE_MS + 120;
/** How long the new shape is allowed to stand still before the next pulse may light it. */
const SETTLED_MS = 260;

/**
 * Derived, never chosen: the whole handover has to finish inside the gap. The extra 80ms is the
 * mask rebuild, which is debounced until the shape has stopped moving. Pick this by hand and
 * the light eventually starts running a rim that is still moving, against a stale mask.
 */
const GAP_MS = HANDOVER_AT - PULSE_MS + FADE_OUT_MS + MORPH_MS + 80 + SETTLED_MS;

export function MorphCard({
  paletteRef,
  faceClassName = "",
  onPulse,
}: {
  /**
   * The element the palette is written to — the stage, not the card. Custom properties inherit,
   * so one roll colours the rim *and* the surface the card stands on; rolling onto the card
   * instead would leave the stage on its initial colour forever, silently.
   */
  paletteRef: React.RefObject<HTMLElement | null>;
  faceClassName?: string;
  /**
   * Called on the beat that lights the rim, so something outside the card can be lit by the
   * same light rather than by a clock of its own. A second clock is the failure this exists to
   * prevent: the pulse stops while the tab is hidden and any independent loop would come back
   * out of phase, which reads as two unrelated effects.
   */
  onPulse?: () => void;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const { sizes, probe } = useVariantSizes();

  const [slot, setSlot] = useState(0);
  const slotRef = useRef(0);
  /** Contents are on screen. Off during the fade-out and the morph. */
  const [showing, setShowing] = useState(true);
  const [morphing, setMorphing] = useState(false);
  /** Bumped on every handover so the arriving text remounts and actually animates. */
  const [generation, setGeneration] = useState(0);

  const timers = useRef<number[]>([]);
  const clearTimers = useCallback(() => {
    for (const timer of timers.current) window.clearTimeout(timer);
    timers.current = [];
  }, []);
  const after = useCallback((ms: number, run: () => void) => {
    timers.current.push(window.setTimeout(run, ms));
  }, []);

  const variant = variantAt(slot);
  const size = sizes?.[slot];
  // Resolved against the box the variant will occupy, always as a real number — see `radiusFor`
  // for why a pill written as 9999 would ruin the morph.
  const radius = radiusFor(variant, (size?.h ?? 0) + 2);

  // Debounced by more than the morph, so the rebuild happens once, after the box has stopped.
  const layers = useRimMask(bodyRef, radius, 90);

  useAiPulse({
    ref: bodyRef,
    paletteRef,
    pulseMs: PULSE_MS,
    gapMs: GAP_MS,
    onPulse: () => {
      onPulse?.();
      clearTimers();
      after(HANDOVER_AT, () => {
        setShowing(false);

        after(FADE_OUT_MS, () => {
          // The attribute goes rather than being set false: the animation is `both`, so it is
          // holding its final frame, and removing the rule is what releases the layers before
          // they are taken out of the layout entirely.
          bodyRef.current?.removeAttribute("data-playing");
          setMorphing(true);
          slotRef.current = (slotRef.current + 1) % VARIANTS.length;
          setSlot(slotRef.current);

          after(MORPH_MS, () => {
            setMorphing(false);
            setGeneration((count) => count + 1);
            setShowing(true);
          });
        });
      });
    },
  });

  useEffect(() => clearTimers, [clearTimers]);

  return (
    <div aria-hidden="true" className="relative flex w-full justify-center">
      {probe}

      <div
        ref={bodyRef}
        data-morphing={morphing ? "true" : undefined}
        className="ai-lights relative p-px transition-[width,height,border-radius] duration-[var(--m)] ease-[cubic-bezier(0.22,1,0.36,1)]"
        style={{
          width: size ? `${size.w + 2}px` : undefined,
          height: size ? `${size.h + 2}px` : undefined,
          borderRadius: `${radius}px`,
          ["--m" as string]: `${MORPH_MS}ms`,
        }}
      >
        <RimGlow layers={layers} />

        {/*
          The face is inset by the body's one pixel of padding — that pixel *is* the gap the
          ring lives in — and its radius is one less, so the two stay concentric. Its colour
          transitions over the same beat as the shape, or the terminal's polarity flips on a
          single frame.
        */}
        <div
          className={`relative h-full w-full overflow-hidden transition-colors duration-[var(--m)] ease-[cubic-bezier(0.22,1,0.36,1)] ${faceClassName}`}
          style={{
            borderRadius: `${Math.max(0, radius - 1)}px`,
            backgroundColor: DARK_KEYS.has(variant.key) ? "#1e1e1e" : "var(--s-surface-2)",
          }}
        >
          <div
            key={generation}
            data-morphing={morphing ? "true" : undefined}
            className={`ai-contents relative h-full w-full transition-opacity duration-[var(--f)] ease-[cubic-bezier(0.22,1,0.36,1)] ${variant.pad}`}
            style={{
              opacity: showing ? 1 : 0,
              ["--f" as string]: `${FADE_OUT_MS}ms`,
            }}
          >
            <variant.Content />
          </div>
        </div>
      </div>
    </div>
  );
}
