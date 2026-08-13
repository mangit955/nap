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

import { useElapsed } from "../ui/use-elapsed.ts";

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
  // Tenths, because the server replaces this a moment later with its own `Done · 12.4s` and
  // the handover should read as one measurement rather than two.
  const elapsed = useElapsed({ startedAt, precision: 1, tickMs: TICK_MS });

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
