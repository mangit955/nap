"use client";

/**
 * The four things the body becomes, and the machinery that measures them.
 *
 * They are surfaces from one product family — the kind of interface that sits around a model
 * while it works — rather than generic buttons and toggles. "Something is running" is the state
 * the light already announces; a generic control would say nothing at all, and the rotation
 * would read as a widget demo rather than as one object changing its mind.
 *
 * **A variant is contents plus the shape the body should take to hold them.** It draws no
 * container of its own, and critically it must never set its own width or height: it sizes the
 * shared body *by being measured*, so anything that pins its own box makes the morph animate to
 * the wrong place. The fixed widths below are on the inner content, which is what gives each
 * variant a stable measured box — the body is what must not be told its size.
 *
 * There is no accent colour anywhere in here. A saturated hue fights a rainbow rim, and the rim
 * is the point.
 */

import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";
import { RisingText } from "./rising-text.tsx";

/** Padding is a variant's own, because it is part of the box being measured. */
const BOX = "px-5 py-3.5";
const BOX_CONTROL = "py-2.5 pr-2.5 pl-5";

export type Variant = {
  key: string;
  /** A real number, resolved against the box the variant will occupy. Never 9999. */
  radius: number | "pill";
  pad: string;
  Content: () => ReactElement;
};

/** The muted figure on the right of a row — a percentage, a count. */
function Trail({ children, delay = 140 }: { children: React.ReactNode; delay?: number }) {
  return (
    <span
      className="shrink-0 animate-[ai-char-fade_300ms_ease_both] text-[13px] text-[var(--s-text-subtle)] leading-none tabular-nums"
      style={{ animationDelay: `${delay}ms` }}
    >
      {children}
    </span>
  );
}

/** One row: body left, trail right, centred against each other. */
function Row({ children, trail }: { children: React.ReactNode; trail?: React.ReactNode }) {
  return (
    <span className="flex items-center gap-2">
      <span className="min-w-0 flex-1">{children}</span>
      {trail}
    </span>
  );
}

/**
 * One node on the workflow track. Three states, three weights of the same ink — `done` is muted
 * because it is finished and no longer needs attention, `live` is full strength, `next` is an
 * outline: present, but not yet real.
 */
function Step({
  label,
  state,
  delay,
}: {
  label: string;
  state: "done" | "live" | "next";
  delay: number;
}) {
  return (
    <span className="flex flex-1 flex-col items-center gap-2">
      <span
        className="relative grid size-3.5 shrink-0 animate-[ai-char-fade_300ms_ease_both] place-items-center"
        style={{ animationDelay: `${delay}ms` }}
      >
        <span
          className={
            state === "done"
              ? "size-3 rounded-[4px] bg-[var(--s-text-subtle)]"
              : state === "live"
                ? "size-3 rounded-[4px] bg-[var(--s-text-primary)]"
                : "size-3 rounded-[4px] border border-[var(--s-border-1)] bg-[var(--s-surface-2)]"
          }
        />
        {state === "live" && (
          <span className="absolute inset-[-3px] animate-[ai-ring_1.8s_ease-out_infinite] rounded-[6px] border border-[var(--s-text-primary)]" />
        )}
      </span>

      <span
        className="animate-[ai-char-fade_300ms_ease_both] text-[14px] leading-none"
        style={{
          animationDelay: `${delay + 60}ms`,
          color: state === "next" ? "var(--s-text-subtle)" : "var(--s-text-body)",
        }}
      >
        {label}
      </span>
    </span>
  );
}

/**
 * A workflow node: the one thing this variant has that none of the others do is **sequence**.
 * Three steps joined by a hairline, the middle one running. The labels sit under the track so
 * the eye reads the shape first and the words second.
 */
function WorkflowContent() {
  const steps: { label: string; state: "done" | "live" | "next" }[] = [
    { label: "Fetch", state: "done" },
    { label: "Parse", state: "live" },
    { label: "Write", state: "next" },
  ];

  return (
    <span className="block w-[268px]">
      <span className="relative flex items-start">
        {/* Inset to the centres of the outer nodes, so the line joins them rather than
            running past them into the padding. */}
        <span
          className="absolute top-[7px] right-[16.667%] left-[16.667%] h-px animate-[ai-char-fade_300ms_ease_both] bg-[var(--s-border-1)]"
          style={{ animationDelay: "60ms" }}
        />
        {steps.map((step, index) => (
          <Step key={step.label} {...step} delay={100 + index * 70} />
        ))}
      </span>
    </span>
  );
}

/** A progress row: a name, a figure, and something turning. */
function ProgressContent() {
  return (
    <span className="block w-[246px]">
      <Row
        trail={
          <span className="flex items-center gap-1.5">
            <Trail delay={120}>45%</Trail>
            <svg viewBox="0 0 16 16" className="size-3.5 shrink-0" aria-hidden="true">
              <circle
                cx="8"
                cy="8"
                r="6"
                className="fill-none stroke-[var(--s-border-1)]"
                strokeWidth="2"
              />
              <path
                d="M8 2A6 6 0 0 1 14 8"
                className="animate-[ai-spin_900ms_linear_infinite] fill-none stroke-[var(--s-text-body)]"
                strokeWidth="2"
                strokeLinecap="round"
                style={{ transformOrigin: "8px 8px" }}
              />
            </svg>
          </span>
        }
      >
        <RisingText text="Indexing" className="text-[16px] text-[var(--s-text-body)]" />
      </Row>
    </span>
  );
}

/**
 * The only variant that inverts, and the biggest jump in the rotation: a change of polarity
 * lands harder than any change of proportion.
 *
 * The `$` stays. In a terminal it is not decoration — it is what tells you the line is a
 * command rather than output.
 */
function TerminalContent() {
  return (
    <span className="block w-[242px] space-y-2 font-mono">
      <span className="block text-[#8c8c8c] text-[14px] leading-none">
        <span className="text-[#5f5f5f]">$</span> deploy
      </span>
      <RisingText text="published" className="text-[#d6d6d6] text-[14px]" delay={60} />
    </span>
  );
}

/**
 * A prompt bar: intent in, action out. The send mark sits in the trail slot, and the box uses
 * the trimmed padding so its bulk does not read as a wider right margin than the text has left.
 *
 * This is the shape the card settles into when somebody engages with it — at which point the
 * words below are replaced by a real input.
 */
function PromptContent() {
  return (
    <span className="block w-[282px]">
      <Row
        trail={
          <span className="grid size-8 shrink-0 place-items-center rounded-[9px] bg-[var(--s-text-primary)]">
            <svg
              viewBox="0 0 12 12"
              className="size-4 fill-none stroke-[var(--s-text-inverse)]"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M6 9.5V2.5M6 2.5 3 5.5M6 2.5 9 5.5" />
            </svg>
          </span>
        }
      >
        <RisingText
          text="build me a habit tracker"
          className="text-[16px] text-[var(--s-text-muted)]"
        />
      </Row>
    </span>
  );
}

/**
 * The rotation, ordered so the body never makes the same kind of move twice running: a wide
 * node, a shorter row, the dark panel, then a bar — and out of that bar into the real input.
 */
export const VARIANTS: Variant[] = [
  { key: "workflow", radius: 16, pad: BOX, Content: WorkflowContent },
  { key: "progress", radius: 15, pad: BOX, Content: ProgressContent },
  { key: "terminal", radius: 16, pad: BOX, Content: TerminalContent },
  { key: "prompt", radius: 18, pad: BOX_CONTROL, Content: PromptContent },
];

/** Variants whose face inverts. The body reads this to pick its face colour. */
export const DARK_KEYS = new Set(["terminal"]);

/**
 * The variant at a position in the rotation, wrapping. The throw is for programmer error — an
 * empty rotation is a code change, not a state the card can reach — and it exists so callers
 * are handed a variant rather than a maybe-variant they would have to branch on every use.
 */
export function variantAt(index: number): Variant {
  const wrapped = ((index % VARIANTS.length) + VARIANTS.length) % VARIANTS.length;
  const variant = VARIANTS[wrapped];
  if (variant === undefined) throw new Error("VARIANTS is empty; the card has nothing to be");
  return variant;
}

/**
 * Resolve a radius against the box it will occupy.
 *
 * A pill is normally written as an absurd radius the browser clamps to half the height, and
 * that is fine while nothing moves — but it **interpolates numerically**, so a morph from 9999
 * to 16 stays above the clamp for about nine tenths of its duration, renders a full stadium the
 * whole way, and collapses to the real corner in the last few frames. It reads as the shape
 * lagging and then snapping. Resolving to a real number is what makes the corner travel with
 * the box.
 */
export function radiusFor(variant: Variant, height: number): number {
  return variant.radius === "pill" ? height / 2 : variant.radius;
}

export type Size = { w: number; h: number };

/**
 * Every variant's natural box, measured once off-screen.
 *
 * Hardcoding these drifts the moment any content or padding changes, and the body needs real
 * pixel targets because the browser will not transition to `width: auto`.
 *
 * `visibility: hidden` rather than `display: none` for the probe — a display-none element has
 * no box to measure at all. And the measurement is taken again after the fonts have loaded, or
 * every width is the fallback font's.
 */
export function useVariantSizes(): { sizes: Size[] | null; probe: ReactElement } {
  const ref = useRef<HTMLDivElement>(null);
  const [sizes, setSizes] = useState<Size[] | null>(null);

  useEffect(() => {
    const host = ref.current;
    if (host === null) return;

    const measure = () => {
      const boxes = Array.from(host.querySelectorAll<HTMLElement>("[data-probe]")).map(
        (element) => {
          const box = element.getBoundingClientRect();
          return { w: Math.round(box.width), h: Math.round(box.height) };
        },
      );
      // All or nothing: a partial read would morph the body to a box some other variant
      // occupies, which looks like the wrong variant being rendered.
      if (boxes.length === VARIANTS.length && boxes.every((box) => box.w > 0 && box.h > 0)) {
        setSizes(boxes);
      }
    };

    measure();
    document.fonts?.ready.then(measure).catch(() => {});
  }, []);

  const probe = (
    <div
      ref={ref}
      aria-hidden="true"
      className="pointer-events-none invisible absolute top-0 left-0 -z-10"
    >
      {VARIANTS.map((variant) => (
        <div key={variant.key} data-probe className={`inline-block ${variant.pad}`}>
          <variant.Content />
        </div>
      ))}
    </div>
  );

  return { sizes, probe };
}
