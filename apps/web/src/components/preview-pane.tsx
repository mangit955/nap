"use client";

import { useEffect, useState } from "react";
import { NapLoader } from "../brand/nap-loader.tsx";
import { NapMark } from "../brand/nap-mark.tsx";
import { pickDifferent } from "../brand/nap-tricks.ts";
import { turnFailureCopy } from "../errors/failure-copy.ts";
import type { ProjectPhase } from "../projects/project-phase.ts";
import { AlertIcon } from "../ui/icons.tsx";
import { useElapsed } from "../ui/use-elapsed.ts";
import { previewUrlFor } from "../workspace/route-path.ts";
import { Pane } from "./pane.tsx";

/**
 * The user's app, running.
 *
 * **A reload here is a remount.** The frame is cross-origin, so nothing on this side can call
 * `location.reload()` on it — the only mechanism available is to discard the element and make
 * a new one. `key` carries both the sequence number of the announcement that produced this
 * preview and a click counter, so a restarted dev server and the reload button take the same
 * path, and an ordinary event arriving does *not* take it. Remounting on every event would
 * reload the user's app each time the agent spoke.
 *
 * **The frame is sandboxed.** What runs in it was written by a model from whatever someone
 * typed into a chat box. It is served from its own origin, so `allow-same-origin` grants it
 * nothing on this page — it only lets the app keep storage and `fetch` of its own — while
 * `allow-scripts` is what makes a React app run at all.
 */

/** The frame's accessible name. An iframe has no implicit role, so this is how it is found. */
export const PREVIEW_TITLE = "App preview";

const SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-modals";

/**
 * What the ghost is up to while a project comes back.
 *
 * Flavour, and unmistakably so — nothing here claims a step has finished, because nothing in
 * the system reports one. The factual line sits underneath, unchanged, with a clock beside it.
 */
const WAITING_WORDS = [
  "Waking up",
  "Stretching",
  "Yawning",
  "Rummaging about",
  "Finding your files",
  "Putting the kettle on",
  "Tidying up",
] as const;

/** Long enough to read, short enough that the screen is never still for long. */
const WORD_MS = 2800;

export type PreviewPaneProps = {
  /**
   * What the project is doing, decided in one place. See `projects/project-phase.ts` — this pane
   * used to fold the log itself and then apply two overrides of its own on top, which is how it
   * came to disagree with the file tree about whether a project was running.
   */
  phase: ProjectPhase;
  onResume?: (() => void) | undefined;
  resumeError?: string | undefined;
  /** The page the frame is being sent to. Owned above, since the bar that sets it is up there. */
  route?: string | undefined;
  /** Bumped by the bar's Reload button; the frame's key reads it. */
  reloads?: number | undefined;
};

export function PreviewPane({
  phase,
  onResume,
  resumeError,
  route = "/",
  reloads = 0,
}: PreviewPaneProps) {
  return (
    // No title bar: the workbench's tabs say which half this is, and the controls that used to
    // sit here — the host, Reload, Open — are in the one bar across the top, where they stay
    // reachable while somebody is looking at the code.
    <Pane id="preview" title="Preview" chrome="none">
      {/* Narrowed on the phase itself rather than on a flag, so the waiting half is typed. */}
      {phase.kind !== "running" ? (
        <Waiting
          phase={phase}
          {...(onResume === undefined ? {} : { onResume })}
          {...(resumeError === undefined ? {} : { resumeError })}
        />
      ) : (
        <iframe
          // Three things remount the frame and nothing else may: a new announcement, the reload
          // button, and being sent to another page. **The tab is deliberately absent** — the
          // panel is hidden rather than unmounted, so glancing at the code cannot reload
          // somebody's app.
          key={`${phase.seq}:${reloads}:${route}`}
          src={previewUrlFor(phase.url, route)}
          title={PREVIEW_TITLE}
          sandbox={SANDBOX}
          className="h-full w-full border-0 bg-white"
        />
      )}
    </Pane>
  );
}

/** Everything that is not the app: nothing asked for yet, coming up, put away, or broken. */
function Waiting({
  phase,
  onResume,
  resumeError,
}: {
  phase: Exclude<ProjectPhase, { kind: "running" }>;
  onResume?: (() => void) | undefined;
  resumeError?: string | undefined;
}) {
  return (
    // No box. The workbench already draws a bordered panel around this, so a second frame two
    // pixels inside it was a box in a box — and it was *dashed*, which reads as a drop zone
    // waiting for content rather than as a state the project is in.
    <div className="flex h-full items-center justify-center p-8">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        {phase.kind === "idle" && (
          <>
            {/*
              Deliberately no mark here. The chat pane's empty state is showing one a few
              hundred pixels to the left, and two of them side by side reads as a mistake.
            */}
            <p className="font-display font-semibold text-[15px] text-ink">Nothing running yet</p>
            <p className="text-[12.5px] text-muted leading-relaxed">
              Describe an app in the chat and it appears here.
            </p>
          </>
        )}

        {(phase.kind === "starting" || phase.kind === "opening") && <StartingUp />}

        {phase.kind === "put-away" && <PutAway onResume={onResume} error={resumeError} />}

        {phase.kind === "failed" && <PreviewFailure message={phase.message} />}
      </div>
    </div>
  );
}

/**
 * The wait while a sandbox comes up, which is tens of seconds in an otherwise empty pane.
 *
 * Three things, and each says something the others cannot. The **ghost** says the page is
 * alive. The **word above the line** changes every few seconds, which is what stops a static
 * screen reading as a stalled one — and it is deliberately whimsy rather than a phase, because
 * **nothing reports the real phase**: a restore emits no progress events, so "Installing
 * dependencies…" would be a number invented to look informative. The **elapsed count** is the
 * one hard fact available, and it is the thing that distinguishes slow from stuck.
 *
 * Only the fixed line is announced. A reader gets "Starting the dev server" once rather than a
 * new word every three seconds, and a clock that would be read out on every tick.
 */
function StartingUp() {
  const word = useRotating(WAITING_WORDS, WORD_MS);
  const elapsed = useElapsed({ precision: 0 });

  return (
    <>
      {/*
        The ghost rather than a spinner, and big enough to be a character rather than an icon:
        a 20px spinner in a pane this size stops reading as progress about two seconds in.
      */}
      <NapLoader className="size-14 text-ink-2" />

      <div className="flex flex-col items-center gap-1">
        {/* The same shimmer the transcript's working indicator uses, so waiting looks like one
            thing wherever it happens. */}
        <p aria-hidden="true" className="nap-shimmer text-[13px]">
          {word}…
        </p>
        <p className="font-mono text-[11px] text-muted tabular-nums">
          Starting the dev server · <span aria-hidden="true">{elapsed}</span>
        </p>
      </div>
    </>
  );
}

/**
 * A different word every `everyMs`, and never the one before it.
 *
 * The same pick the ghost's own tricks use, for the same reason: a fixed rotation is learned in
 * one cycle, after which the screen may as well be static again.
 */
function useRotating(words: readonly string[], everyMs: number): string {
  const [word, setWord] = useState(() => words[0] ?? "");

  useEffect(() => {
    const timer = setInterval(() => {
      setWord((previous) => pickDifferent(words, previous, Math.random()));
    }, everyMs);

    return () => clearInterval(timer);
  }, [words, everyMs]);

  return word;
}

/**
 * The pane for a project nobody is paying for right now.
 *
 * **It says the files are safe before it says anything else**, because that is the question
 * somebody has on finding their app gone. It is also true: the work is in a snapshot, and the
 * only thing that was destroyed is the machine that was serving it.
 *
 * Sending a message also brings a project back, so this is a shortcut rather than the only way
 * through — which is why the button is offered rather than demanded, and why a refusal leaves
 * it on screen instead of replacing it.
 */
function PutAway({
  onResume,
  error,
}: {
  onResume?: (() => void) | undefined;
  error?: string | undefined;
}) {
  return (
    <>
      {/*
        The sleeping mark, which is the one place in the app where the brand's own metaphor is
        literally the state being described: the project is having a nap.
      */}
      <NapMark className="size-8 text-muted" />

      <p className="font-display font-semibold text-[15px] text-ink">This project is put away.</p>
      <p className="text-[12.5px] text-muted leading-relaxed">
        Its files are still saved. Starting it back up takes a few seconds.
      </p>

      {/*
        Solid, matching the composer's send button. The outlined accent version here was the
        only button of its kind in the app — and resuming is the primary action of this screen,
        so it should look like one.
      */}
      <button
        type="button"
        onClick={() => onResume?.()}
        className="mt-1 rounded-chip bg-ink px-3.5 py-1.5 font-medium text-[12.5px] text-surface transition-transform duration-150 hover:bg-white active:scale-[0.98] focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
      >
        Resume
      </button>

      {error !== undefined && (
        // A live region: it appears in response to a press, and a message that only changes
        // visually is one a screen reader never mentions.
        <p role="alert" className="mt-1 font-mono text-[11px] text-danger">
          {error}
        </p>
      )}
    </>
  );
}

/**
 * The pane's failure state, in the same words the transcript uses for the same event.
 *
 * Both are downstream of one `turn.failed{sandbox_unavailable}`, and this pane used to have its
 * own wording for it — so a single failure read as two different problems depending on which
 * half of the screen you looked at. The copy comes from one place now; no retry button here,
 * because the transcript already offers one and two controls for one action is a question about
 * which of them is the real one.
 */
function PreviewFailure({ message }: { message: string }) {
  const copy = turnFailureCopy("sandbox_unavailable", message);

  return (
    // The same danger-tinted card the transcript gives a failed turn, so one failure looks like
    // one thing wherever somebody happens to be looking.
    <div className="flex flex-col items-center gap-1.5 rounded-xl border border-danger/30 bg-danger/[0.06] px-5 py-4">
      <AlertIcon className="size-5 text-danger" />
      <p className="font-medium text-[13px] text-danger">{copy.title}</p>
      <p className="font-mono text-[11px] text-muted">{copy.detail}</p>
      <p className="text-[12px] text-muted leading-relaxed">{copy.action}</p>
    </div>
  );
}
