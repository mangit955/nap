/*
 * Ported from T3 Code (github.com/pingdotgg/t3code), apps/web/src/components/chat/EffortGlyph.tsx.
 * MIT License, Copyright (c) 2026 T3 Tools Inc. See THIRD_PARTY_NOTICES.md.
 */

import type { Effort } from "@nap/shared/model-lines";

const GLYPH_HEIGHT = 14;
// Bars stop this far above the box's bottom, which puts their flat base on the text baseline.
const BASELINE_INSET = 2;

/** How each level is named where it is written out. */
export const EFFORT_LABELS: Record<Effort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

/**
 * One bar per ordinary level, filled up to the current one. Max is named rather than drawn, so the
 * bars stop short of it — a full row of bars would read as "as high as it goes", which is Max's
 * own claim.
 */
export function resolveEffortGlyph(
  levels: readonly Effort[],
  current: Effort,
): { count: number; filled: number; word: string | null } | null {
  const bars = levels.filter((level) => level !== "max");
  if (bars.length < 2) return null;
  if (current === "max") return { count: bars.length, filled: bars.length, word: "Max" };
  const index = bars.indexOf(current);
  if (index < 0) return null;
  return { count: bars.length, filled: index + 1, word: null };
}

/** Bar heights that rise by one whole-pixel step, from about half height up to `maxBar`. */
export function effortBarHeights(count: number, maxBar: number): number[] {
  // Rounding each bar separately mixes 1px and 2px steps, so round the step once.
  const step = Math.max(1, Math.round(maxBar / 2 / Math.max(count - 1, 1)));
  return Array.from({ length: count }, (_, index) => maxBar - (count - 1 - index) * step);
}

/** Rising bars on whole pixels so they stay sharp on 1x displays. Color follows the text. */
export function EffortGlyph(props: { count: number; filled: number }) {
  const step = 4;
  const width = step * props.count - 2;
  const maxBar = GLYPH_HEIGHT - BASELINE_INSET;
  return (
    <svg
      aria-hidden="true"
      width={width}
      height={GLYPH_HEIGHT}
      viewBox={`0 0 ${width} ${GLYPH_HEIGHT}`}
      style={{ width, height: GLYPH_HEIGHT }}
      className="shrink-0 text-current"
      data-effort-glyph
    >
      {effortBarHeights(props.count, maxBar).map((barHeight, index) => {
        const x = index * step;
        return (
          <rect
            key={x}
            x={x}
            y={maxBar - barHeight}
            width={2}
            height={barHeight}
            fill="currentColor"
            opacity={index < props.filled ? 1 : 0.4}
          />
        );
      })}
    </svg>
  );
}
