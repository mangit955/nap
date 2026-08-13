"use client";

/**
 * How long something has been going on, as a string.
 *
 * **Read off the clock each tick rather than accumulated by counting them.** A background tab
 * throttles intervals, so a counter that added a fixed step per fire would drift further behind
 * the longer nobody was looking — and the whole point of showing elapsed time during a wait is
 * that it is the one number on screen a person can trust.
 *
 * Two callers want different faces on the same idea. The transcript's working indicator counts
 * in tenths, because the server replaces it a moment later with `Done · 12.4s` and the handover
 * should read as one measurement. A pane waiting on a sandbox counts in whole seconds: a tenths
 * digit flickering ten times a second beside a large mark is noise pretending to be progress.
 */

import { useEffect, useState } from "react";

export type ElapsedOptions = {
  /** When the thing began, from the server. Absent means "when this appeared". */
  startedAt?: string | undefined;
  /** Digits after the decimal point. Zero counts whole seconds. */
  precision?: 0 | 1;
  /** How often to re-read the clock. */
  tickMs?: number;
};

export function useElapsed(options: ElapsedOptions = {}): string {
  const { startedAt, precision = 1, tickMs = precision === 0 ? 500 : 100 } = options;

  // Mount time is the fallback, and it has to be captured once rather than read each render —
  // recomputing it would move the anchor forward in step with the clock and pin the elapsed
  // time at zero. It is a *fallback*: `startedAt` arrives a moment after this appears, and
  // taking it the moment it does is what makes the count survive a reload.
  const [mountedAt] = useState(() => Date.now());
  const parsed = startedAt === undefined ? Number.NaN : Date.parse(startedAt);
  const anchor = Number.isNaN(parsed) ? mountedAt : parsed;

  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), tickMs);
    return () => clearInterval(timer);
  }, [tickMs]);

  // Clamped, because the anchor may come from the server and this subtraction from the browser.
  // A clock a few seconds ahead of ours would otherwise render the wait as not yet begun.
  const seconds = Math.max(0, now - anchor) / 1000;
  if (seconds < 60) return `${seconds.toFixed(precision)}s`;
  return `${Math.floor(seconds / 60)}m ${(seconds % 60).toFixed(precision)}s`;
}
