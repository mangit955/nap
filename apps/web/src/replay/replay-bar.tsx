"use client";

import { ArrowRight, Pause, Play, RotateCcw, SkipForward } from "lucide-react";
import type { PlaybackState } from "./use-playback.ts";

const RECORDED_ON = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

/**
 * Where the composer sits in a live session: what this is, and the only things a viewer can do
 * with it.
 *
 * It says, in the place a person would otherwise type, that nothing is running. A replay drawn
 * in the real workspace is exactly as convincing as a live one, which is the point of it and also
 * why it has to say which it is.
 */
export function ReplayBar({
  recordedAt,
  model,
  state,
  onPause,
  onResume,
  onRestart,
  onSkip,
  onOpenApp,
}: {
  recordedAt: string;
  model: string;
  state: PlaybackState;
  onPause: () => void;
  onResume: () => void;
  onRestart: () => void;
  onSkip: () => void;
  /** Absent while the app is already on screen. */
  onOpenApp?: (() => void) | undefined;
}) {
  const button =
    "flex h-8 items-center gap-1.5 rounded-full px-3 text-xs text-ink-2 hover:bg-hover hover:text-ink focus-visible:outline-accent [&_svg]:size-3.5";
  return (
    <div className="chat-input relative mx-auto w-full max-w-[46rem] px-4 pt-2 pb-4">
      <section aria-label="Replay" className="workspace-composer relative px-4 py-3">
        <p className="text-xs text-ink-2">
          A recorded session, played back from its log. Nothing runs while you watch.
        </p>
        <p className="mt-0.5 text-[11px] text-muted">
          Recorded {RECORDED_ON.format(new Date(recordedAt))} on {model}. Long pauses are shortened.
        </p>
        <div className="-mx-2 mt-2 flex flex-wrap items-center gap-1">
          {state === "playing" && (
            <button type="button" className={button} onClick={onPause}>
              <Pause aria-hidden="true" /> Pause
            </button>
          )}
          {state === "paused" && (
            <button type="button" className={button} onClick={onResume}>
              <Play aria-hidden="true" /> Resume
            </button>
          )}
          {state === "ended" ? (
            <button type="button" className={button} onClick={onRestart}>
              <RotateCcw aria-hidden="true" /> Watch again
            </button>
          ) : (
            <button type="button" className={button} onClick={onSkip}>
              <SkipForward aria-hidden="true" /> Skip to the end
            </button>
          )}
          {onOpenApp && (
            <button type="button" className={button} onClick={onOpenApp}>
              See the app
            </button>
          )}
          <a
            href="/sign-up"
            className="ml-auto flex h-8 items-center gap-1.5 rounded-full bg-ink px-3 font-medium text-surface text-xs hover:opacity-90 focus-visible:outline-accent [&_svg]:size-3.5"
          >
            Build your own <ArrowRight aria-hidden="true" />
          </a>
        </div>
      </section>
    </div>
  );
}
