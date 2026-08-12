"use client";

/**
 * The agent is working, and this is the only thing on the rail that moves while it does.
 *
 * A turn is bursts of tool calls with ten- and twenty-second silences between them, and during
 * a silence every other surface is static: the steps above have all finished, the input is
 * disabled, and nothing distinguishes a model that is thinking from a server that has died. So
 * three things move here, and each says something the others cannot — a grid that says *alive*,
 * a label that says *what*, and a clock that says *how long*.
 *
 * **A 3×3 grid of 4px cells with a chevron wavefront driving right.** The cycle is deliberately
 * shorter than the sweep, so two fronts are in flight at once and the motion never resolves to
 * a rest state — a loader that visibly restarts reads as a thing that has stalled and begun
 * again. Squares rather than dots because the rest of this pane is mono type and hairlines, and
 * a ring of circles would be the one piece of chrome borrowed from somewhere else.
 *
 * **Nothing here is in the accessibility tree except one static phrase.** The facts the three
 * parts carry are all already announced — the open tool call is a step line above with its own
 * `still running`, and the input's button says Stop — so a live region repeating them would
 * announce each tool twice, and a name containing the clock would announce ten times a second.
 * What is left is `role="status"` named once, on insert.
 */

import { useEffect, useState } from "react";

/** Column plus distance from the middle row: a chevron, pointing right. */
const CHEVRON = Array.from({ length: 9 }, (_, index) => {
  const row = Math.floor(index / 3);
  const column = index % 3;
  return (column + Math.abs(row - 1)) * 90;
});

const CYCLE_MS = 650;
const TICK_MS = 100;

export function WorkingIndicator({
  label,
  startedAt,
}: {
  label: string;
  /**
   * When the server says the turn began. Absent in the window between the click and
   * `turn.started` arriving, which is the one case where mount time is the honest answer.
   */
  startedAt?: string | undefined;
}) {
  const elapsed = useElapsed(startedAt);

  return (
    <div role="status" aria-label="Agent is working" className="flex w-fit items-center gap-2.5">
      <span aria-hidden="true" className="grid grid-cols-[repeat(3,4px)] gap-[1.5px]">
        {CHEVRON.map((delay, index) => (
          <span
            // The cells are a fixed, positional grid — there is nothing to key them by but
            // where they are, and nothing ever reorders them.
            // biome-ignore lint/suspicious/noArrayIndexKey: the index is the cell's identity
            key={index}
            className="size-[4px] rounded-[1px] bg-ink nap-pixel"
            style={{ animationDelay: `${delay}ms`, animationDuration: `${CYCLE_MS}ms` }}
          />
        ))}
      </span>

      <span aria-hidden="true" className="nap-shimmer font-medium text-[13px]">
        {label}
      </span>

      {/*
        Tabular figures so the width does not jitter as the digits change — at ten updates a
        second, proportional numerals make the label beside them appear to twitch.
      */}
      <span aria-hidden="true" className="font-mono text-[12px] text-muted tabular-nums">
        {elapsed}
      </span>
    </div>
  );
}

/**
 * Time since the turn began, as a string.
 *
 * Read off the clock each tick rather than accumulated by counting them: a background tab
 * throttles intervals, and a counter that adds 100ms per fire would drift further behind the
 * longer nobody was looking. Tenths, because this is replaced a moment later by the
 * `Done · 12.4s` line the server computes, and the handover should read as one measurement.
 */
function useElapsed(startedAt: string | undefined): string {
  // Mount time is the fallback, and it has to be captured once rather than read each render —
  // recomputing it would move the anchor forward in step with the clock and pin the elapsed
  // time at zero. It is a *fallback*: `startedAt` arrives a moment after the indicator appears,
  // and taking it the moment it does is what makes the count survive a reload.
  const [mountedAt] = useState(() => Date.now());
  const parsed = startedAt === undefined ? Number.NaN : Date.parse(startedAt);
  const anchor = Number.isNaN(parsed) ? mountedAt : parsed;

  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, []);

  // Clamped, because the anchor comes from the server and this subtraction from the browser.
  // A clock a few seconds ahead of ours would otherwise render the turn as not yet begun.
  const seconds = Math.max(0, now - anchor) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  return `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(1)}s`;
}
