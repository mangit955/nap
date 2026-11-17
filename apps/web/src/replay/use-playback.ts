"use client";

import type { StoredEvent } from "@nap/shared/ports/event-store";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { playbackOffsets } from "./playback.ts";

export type PlaybackState = "playing" | "paused" | "ended";

export type Playback = {
  /** The log as far as it has played, timed as if it were happening now. */
  events: StoredEvent[];
  state: PlaybackState;
  pause: () => void;
  resume: () => void;
  restart: () => void;
  skipToEnd: () => void;
};

/**
 * A recorded log, handed out on a clock the way the event stream hands out a live one.
 *
 * **Every timestamp is moved to now.** The workspace draws elapsed time against the wall clock —
 * "Working for 12s" is the distance from a turn's start to this instant — so a log from August
 * played in November would say a turn had been working for three months. Each event is stamped
 * with the moment it would have happened had the session started when playback did, which keeps
 * the gaps between events exactly as `playbackOffsets` says and nothing else.
 *
 * **Events due together are committed together**, as `useEventStream` does with a live burst: a
 * render per event would re-fold the whole log for each line of a command's output.
 */
export function usePlayback(recorded: readonly StoredEvent[]): Playback {
  const offsets = useMemo(() => playbackOffsets(recorded), [recorded]);
  const [events, setEvents] = useState<StoredEvent[]>([]);
  const [state, setState] = useState<PlaybackState>("playing");
  const [run, setRun] = useState(0);
  /** The next event to show. */
  const next = useRef(0);
  /** Playback time already spent before the current stretch of playing. */
  const banked = useRef(0);
  /** When the current stretch of playing began, on the wall clock. */
  const since = useRef(0);

  const stamp = useCallback(
    (from: number, to: number, elapsed: number, now: number): StoredEvent[] =>
      recorded.slice(from, to).map((event, index) => ({
        ...event,
        createdAt: new Date(now - (elapsed - (offsets[from + index] ?? elapsed))).toISOString(),
      })),
    [recorded, offsets],
  );

  // `run` is what a restart changes, so restarting while already playing still re-arms the clock.
  // The bar offers a restart only once playback has ended, but `restart` is this hook's to keep
  // correct whoever calls it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see above
  useEffect(() => {
    if (state !== "playing") return;
    since.current = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      const now = Date.now();
      const elapsed = banked.current + (now - since.current);
      const from = next.current;
      let to = from;
      while (to < offsets.length && (offsets[to] ?? 0) <= elapsed) to++;
      next.current = to;
      if (to > from) {
        const due = stamp(from, to, elapsed, now);
        setEvents((current) => current.concat(due));
      }
      if (to >= offsets.length) {
        setState("ended");
        return;
      }
      timer = setTimeout(tick, (offsets[to] ?? 0) - elapsed);
    };
    tick();
    return () => {
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [state, run, offsets, stamp]);

  // Read by `pause`, which banks the time played so far once and outside any state updater:
  // React may run an updater twice, and a pause would then bank the stretch twice.
  const latest = useRef(state);
  latest.current = state;
  const pause = useCallback(() => {
    if (latest.current !== "playing") return;
    banked.current += Date.now() - since.current;
    setState("paused");
  }, []);
  const resume = useCallback(() => {
    setState((current) => (current === "paused" ? "playing" : current));
  }, []);
  const restart = useCallback(() => {
    next.current = 0;
    banked.current = 0;
    setEvents([]);
    setState("playing");
    setRun((count) => count + 1);
  }, []);
  const skipToEnd = useCallback(() => {
    const from = next.current;
    const last = offsets.at(-1) ?? 0;
    next.current = offsets.length;
    banked.current = last;
    setEvents((current) => current.concat(stamp(from, offsets.length, last, Date.now())));
    setState("ended");
  }, [offsets, stamp]);

  return { events, state, pause, resume, restart, skipToEnd };
}
