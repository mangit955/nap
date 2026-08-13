"use client";

import type { StoredEvent } from "@nap/shared/ports/event-store";
import { useEffect, useRef } from "react";
import { NapMark } from "../brand/nap-mark.tsx";
import { turnFailureCopy } from "../errors/failure-copy.ts";
import { useEventStream } from "../hooks/use-event-stream.ts";
import { isPutAway, type PreviewState, previewState } from "../preview/preview-state.ts";
import { AlertIcon, SpinnerIcon } from "../ui/icons.tsx";
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

export type PreviewPaneProps = {
  events: readonly StoredEvent[];
  /**
   * When the record the page was opened with last said this project had no sandbox.
   *
   * The log is the better source and usually says so itself — every close and every sweep
   * appends `preview.stopped`. This is for the gap in that: a sandbox the provider reclaimed
   * on its own timer is announced by nobody until something notices, so the newest event can
   * still be a `preview.ready` for a host that stopped answering an hour ago.
   *
   * A timestamp rather than a flag, because the record is read once and the world moves: see
   * `isPutAway`.
   */
  putAwayAt?: string | undefined;
  onResume?: (() => void) | undefined;
  /** From the request until the restore announces itself, which can be tens of seconds. */
  resuming?: boolean | undefined;
  resumeError?: string | undefined;
  /** The page the frame is being sent to. Owned above, since the bar that sets it is up there. */
  route?: string | undefined;
  /** Bumped by the bar's Reload button; the frame's key reads it. */
  reloads?: number | undefined;
};

export function PreviewPane({
  events,
  putAwayAt,
  onResume,
  resuming,
  resumeError,
  route = "/",
  reloads = 0,
}: PreviewPaneProps) {
  const state = displayState(previewState(events), { events, putAwayAt, resuming });

  return (
    // No title bar: the workbench's tabs say which half this is, and the controls that used to
    // sit here — the host, Reload, Open — are in the one bar across the top, where they stay
    // reachable while somebody is looking at the code.
    <Pane id="preview" title="Preview" chrome="none">
      {/* Narrowed on `state` itself rather than on `ready`, so the waiting half is typed. */}
      {state.status !== "ready" ? (
        <Waiting
          state={state}
          {...(onResume === undefined ? {} : { onResume })}
          {...(resumeError === undefined ? {} : { resumeError })}
        />
      ) : (
        <iframe
          // Three things remount the frame and nothing else may: a new announcement, the reload
          // button, and being sent to another page. **The tab is deliberately absent** — the
          // panel is hidden rather than unmounted, so glancing at the code cannot reload
          // somebody's app.
          key={`${state.seq}:${reloads}:${route}`}
          src={previewUrlFor(state.url, route)}
          title={PREVIEW_TITLE}
          sandbox={SANDBOX}
          className="h-full w-full border-0 bg-white"
        />
      )}
    </Pane>
  );
}

/**
 * What the pane shows, which is not always what the log last said.
 *
 * Two overrides, both about the log being behind rather than wrong. A project whose record says
 * it has no sandbox has none, whatever address an *older* `preview.ready` carries — nothing
 * announces a sandbox the provider reclaimed on its own timer. And a restore that has been
 * asked for is under way from the moment it is asked for, which is minutes before the event
 * saying so arrives.
 *
 * **Only a `ready` state is overridden.** A project with no sandbox and nothing asked for yet is
 * a new project, and inviting a first prompt is the right thing to say to that; offering to
 * restore it would imply there was something to restore.
 */
function displayState(
  state: PreviewState,
  overrides: {
    events: readonly StoredEvent[];
    putAwayAt?: string | undefined;
    resuming?: boolean | undefined;
  },
): PreviewState {
  if (overrides.resuming === true) return { status: "starting" };
  if (state.status === "ready" && isPutAway(overrides.events, overrides.putAwayAt)) {
    return { status: "stopped" };
  }
  return state;
}

/** Everything that is not the app: nothing asked for yet, coming up, put away, or broken. */
function Waiting({
  state,
  onResume,
  resumeError,
}: {
  state: Exclude<PreviewState, { status: "ready" }>;
  onResume?: (() => void) | undefined;
  resumeError?: string | undefined;
}) {
  return (
    // No box. The workbench already draws a bordered panel around this, so a second frame two
    // pixels inside it was a box in a box — and it was *dashed*, which reads as a drop zone
    // waiting for content rather than as a state the project is in.
    <div className="flex h-full items-center justify-center p-8">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        {state.status === "idle" && (
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

        {state.status === "starting" && (
          <>
            <SpinnerIcon className="size-5 text-accent-ink" />
            {/* The same shimmer the transcript's working indicator uses, so waiting looks
                like one thing wherever it happens. */}
            <p className="nap-shimmer text-[13px]">Starting the dev server…</p>
          </>
        )}

        {state.status === "stopped" && <PutAway onResume={onResume} error={resumeError} />}

        {state.status === "error" && <PreviewFailure message={state.message} />}
      </div>
    </div>
  );
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

/**
 * `resume` and the two flags beside it come from the shell rather than from a hook of this
 * pane's own: the file tree needs the same answer, and two hooks asking the same question would
 * be two requests and two chances to disagree about whether the project is running.
 */
export function LivePreviewPane({
  sessionId,
  putAwayAt,
  onResume,
  onPreviewReady,
  resuming,
  resumeError,
  route,
  reloads,
}: {
  sessionId: string | undefined;
  /**
   * Reports whatever is serving the project — its address, and the `seq` of the announcement
   * that named it. Reported from here rather than read again above because this pane already
   * holds the subscription, and every `useEventStream` is a socket of its own, so asking the
   * same question twice costs a second connection to say the same thing.
   *
   * **The `seq` is not decoration.** It is how the shell tells this restore's preview from the
   * one that was standing before the project was put away — an address alone cannot, and a
   * shell that took the older one would end the wait by pointing an iframe at a dead sandbox.
   */
  onPreviewReady?: ((ready: { url: string; seq: number } | undefined) => void) | undefined;
} & Omit<PreviewPaneProps, "events">) {
  const { events } = useEventStream({ sessionId });
  const state = previewState(events);
  const url = state.status === "ready" ? state.url : undefined;
  const seq = state.status === "ready" ? state.seq : undefined;

  // In an effect rather than during render: this reports *upward*, and a parent setting state
  // while its child renders is the loop React warns about. Keyed on the two primitives rather
  // than on an object built here, which would be a new identity every frame.
  const report = useRef(onPreviewReady);
  report.current = onPreviewReady;
  useEffect(() => {
    report.current?.(url === undefined || seq === undefined ? undefined : { url, seq });
  }, [url, seq]);

  return (
    <PreviewPane
      events={events}
      {...(putAwayAt === undefined ? {} : { putAwayAt })}
      {...(onResume === undefined ? {} : { onResume })}
      {...(resuming === undefined ? {} : { resuming })}
      {...(resumeError === undefined ? {} : { resumeError })}
      {...(route === undefined ? {} : { route })}
      {...(reloads === undefined ? {} : { reloads })}
    />
  );
}
