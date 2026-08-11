"use client";

/**
 * One body that becomes four different surfaces, and then becomes the thing you type into.
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
 * **Settling is the one thing here that is not in the source of this effect.** The rotation is
 * ornamental, but the last shape it takes is a real control, so engaging with the card stops
 * the cycle for good and hands the box to a genuine input. It never resumes: a control that
 * turned back into a demonstration while somebody was deciding what to type would be a betrayal
 * of the thing that made them press it.
 */

import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { RimGlow } from "./rim-glow.tsx";
import { useAiPulse } from "./use-pulse.ts";
import { useRimMask } from "./use-rim-mask.ts";
import {
  DARK_KEYS,
  radiusFor,
  type Size,
  useVariantSizes,
  VARIANTS,
  variantAt,
} from "./variants.tsx";

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
 * mask rebuild, which is debounced until the shape has stopped moving.
 */
const GAP_MS = HANDOVER_AT - PULSE_MS + FADE_OUT_MS + MORPH_MS + 80 + SETTLED_MS;

export function MorphCard({
  settled,
  onSettle,
  settledRadius,
  settledLabel,
  onSettleComplete,
  paletteRef,
  faceClassName = "",
  children,
}: {
  /** Once true, the rotation is over and `children` is what the body holds. */
  settled: boolean;
  /** Called when somebody engages with the card; the character is set if they typed one. */
  onSettle: (typed?: string) => void;
  settledRadius: number;
  /** What the invitation is called for anyone not looking at it. */
  settledLabel: string;
  /**
   * Fired once the settle handover is completely over. Anything wanting to focus the arriving
   * control has to wait for this rather than for `settled`: the contents are remounted at the
   * end of every handover so their entry animation runs at all, and a focus taken before that
   * remount is thrown away with the element that had it.
   */
  onSettleComplete?: () => void;
  /**
   * The element the palette is written to — the stage, not the card. Custom properties inherit,
   * so one roll colours the rim *and* the surface the card stands on; rolling onto the card
   * instead would leave the stage on its initial colour forever, silently.
   */
  paletteRef: React.RefObject<HTMLElement | null>;
  faceClassName?: string;
  children: ReactNode;
}) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const settledProbeRef = useRef<HTMLDivElement>(null);

  const { sizes, probe } = useVariantSizes();

  const [slot, setSlot] = useState(0);
  const slotRef = useRef(0);
  /** Contents are on screen. Off during the fade-out and the morph. */
  const [showing, setShowing] = useState(true);
  const [morphing, setMorphing] = useState(false);
  /** Bumped on every handover so the arriving text remounts and actually animates. */
  const [generation, setGeneration] = useState(0);
  /** The real box, measured at the moment of settling. */
  const [settledSize, setSettledSize] = useState<Size | null>(null);
  /**
   * Set once the settle morph is over, at which point the body drops its pixel size and becomes
   * responsive again — the browser will not transition *to* `auto`, but it is perfectly happy
   * to be handed it after the animation is done.
   */
  const [fluid, setFluid] = useState(false);

  const timers = useRef<number[]>([]);
  const clearTimers = useCallback(() => {
    for (const timer of timers.current) window.clearTimeout(timer);
    timers.current = [];
  }, []);
  const after = useCallback((ms: number, run: () => void) => {
    timers.current.push(window.setTimeout(run, ms));
  }, []);

  const variant = variantAt(slot);
  const demoSize = sizes?.[slot];

  const size = settled ? settledSize : (demoSize ?? null);
  // Resolved against the box the variant will occupy, always as a real number — see `radiusFor`
  // for why a pill written as 9999 would ruin the morph.
  const radius = settled ? settledRadius : radiusFor(variant, (demoSize?.h ?? 0) + 2);

  // Debounced by more than the morph, so the rebuild happens once, after the box has stopped.
  const layers = useRimMask(bodyRef, radius, 90);

  const settledRef = useRef(settled);
  settledRef.current = settled;

  useAiPulse({
    ref: bodyRef,
    paletteRef,
    pulseMs: PULSE_MS,
    gapMs: GAP_MS,
    onPulse: () => {
      // A settled card still breathes — the light is what says the product is awake — but it
      // has nothing left to hand over to.
      if (settledRef.current) return;

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

  const onSettleCompleteRef = useRef(onSettleComplete);
  onSettleCompleteRef.current = onSettleComplete;

  // The settle: the same three beats, ending somewhere the rotation never goes.
  useEffect(() => {
    if (!settled) return;

    clearTimers();
    setShowing(false);

    after(FADE_OUT_MS, () => {
      const box = settledProbeRef.current?.getBoundingClientRect();
      if (box !== undefined && box.width > 0 && box.height > 0) {
        setSettledSize({ w: Math.round(box.width), h: Math.round(box.height) });
      }
      bodyRef.current?.removeAttribute("data-playing");
      setMorphing(true);

      after(MORPH_MS, () => {
        setMorphing(false);
        setGeneration((count) => count + 1);
        setShowing(true);
        setFluid(true);
        // A frame later, so the remounted contents exist to be focused.
        after(0, () => onSettleCompleteRef.current?.());
      });
    });
  }, [settled, after, clearTimers]);

  useEffect(() => clearTimers, [clearTimers]);

  const dark = !settled && DARK_KEYS.has(variant.key);
  const fixed = size !== null && !(settled && fluid);

  return (
    <div className="relative flex w-full justify-center">
      {probe}

      {/*
        The real control, rendered hidden until it is wanted — this is where its box comes from
        when the card settles. `visibility: hidden` rather than `display: none`, because a
        display-none element has no box to measure at all.
      */}
      {!settled && (
        <div
          ref={settledProbeRef}
          aria-hidden="true"
          className="pointer-events-none invisible absolute inset-x-0 top-0 -z-10"
        >
          {children}
        </div>
      )}

      <div
        ref={bodyRef}
        data-morphing={morphing ? "true" : undefined}
        className={`ai-lights relative p-px transition-[width,height,border-radius] duration-[var(--m)] ease-[cubic-bezier(0.22,1,0.36,1)] ${
          settled && fluid ? "w-full" : ""
        }`}
        style={{
          width: fixed && size !== null ? `${size.w + 2}px` : undefined,
          height: fixed && size !== null ? `${size.h + 2}px` : undefined,
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
            backgroundColor: dark ? "#1e1e1e" : "var(--s-surface-2)",
          }}
        >
          <div
            key={generation}
            data-morphing={morphing ? "true" : undefined}
            className={`ai-contents relative h-full w-full transition-opacity duration-[var(--f)] ease-[cubic-bezier(0.22,1,0.36,1)] ${
              settled ? "" : variant.pad
            }`}
            style={{
              opacity: showing ? 1 : 0,
              ["--f" as string]: `${FADE_OUT_MS}ms`,
            }}
          >
            {settled ? (
              children
            ) : (
              // Ornamental, and deliberately not labelled: it changes what it is every few
              // seconds, a label never re-announces, and per-character spans would be spelled
              // out letter by letter. The invitation below is what carries the name.
              <div aria-hidden="true">
                <variant.Content />
              </div>
            )}
          </div>
        </div>

        {/*
          One control over the whole card while it is still a demonstration. It is what makes
          the rotation reachable by keyboard and by click without nesting anything interactive
          inside an ornament — and typing a character settles the card *and* keeps the
          character, so starting to type never costs you the first letter.
        */}
        {!settled && (
          <button
            type="button"
            aria-label={settledLabel}
            onClick={() => onSettle()}
            onKeyDown={(event) => {
              if (event.key.length !== 1 || event.metaKey || event.ctrlKey || event.altKey) return;
              event.preventDefault();
              onSettle(event.key);
            }}
            className="absolute inset-0 z-20 cursor-text rounded-[inherit] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--s-text-primary)] focus-visible:outline-offset-4"
          />
        )}
      </div>
    </div>
  );
}
