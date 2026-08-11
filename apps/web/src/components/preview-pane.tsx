"use client";

import type { StoredEvent } from "@nap/shared/ports/event-store";
import { useState } from "react";
import { turnFailureCopy } from "../errors/failure-copy.ts";
import { useEventStream } from "../hooks/use-event-stream.ts";
import { type PreviewState, previewState } from "../preview/preview-state.ts";
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
   * That the project has no sandbox, according to the record the page was opened with.
   *
   * The log is the better source and usually says so itself — every close and every sweep
   * appends `preview.stopped`. This is for the gap in that: a sandbox the provider reclaimed
   * on its own timer is announced by nobody until something notices, so the newest event can
   * still be a `preview.ready` for a host that stopped answering an hour ago.
   */
  putAway?: boolean | undefined;
  onResume?: (() => void) | undefined;
  /** From the request until the restore announces itself, which can be tens of seconds. */
  resuming?: boolean | undefined;
  resumeError?: string | undefined;
};

export function PreviewPane({
  events,
  putAway,
  onResume,
  resuming,
  resumeError,
}: PreviewPaneProps) {
  const state = displayState(previewState(events), { putAway, resuming });
  const [reloads, setReloads] = useState(0);

  const ready = state.status === "ready" ? state : undefined;

  return (
    <Pane
      id="preview"
      title="Preview"
      action={
        ready === undefined ? undefined : (
          <div className="flex items-center gap-3">
            <span className="font-mono text-muted text-xs">{host(ready.url)}</span>
            <button
              type="button"
              onClick={() => setReloads(reloads + 1)}
              className="rounded border border-edge px-1.5 py-0.5 text-[11px] text-muted hover:text-ink focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
            >
              Reload
            </button>
            <a
              href={ready.url}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-muted underline underline-offset-2 hover:text-ink"
            >
              Open
            </a>
          </div>
        )
      }
    >
      {/* Narrowed on `state` itself rather than on `ready`, so the waiting half is typed. */}
      {state.status !== "ready" ? (
        <Waiting
          state={state}
          {...(onResume === undefined ? {} : { onResume })}
          {...(resumeError === undefined ? {} : { resumeError })}
        />
      ) : (
        <iframe
          key={`${state.seq}:${reloads}`}
          src={state.url}
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
 * Two overrides, both about the log being behind rather than wrong. A project the record says
 * has no sandbox has none, whatever address the newest `preview.ready` carries — nothing
 * announces a sandbox the provider reclaimed on its own timer. And a restore that has been
 * asked for is under way from the moment it is asked for, which is minutes before the event
 * saying so arrives.
 */
function displayState(
  state: PreviewState,
  overrides: { putAway?: boolean | undefined; resuming?: boolean | undefined },
): PreviewState {
  if (overrides.resuming === true) return { status: "starting" };
  if (overrides.putAway === true && state.status === "ready") return { status: "stopped" };
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
    <div className="flex h-full items-center justify-center p-6">
      <div className="flex w-full max-w-md flex-col items-center gap-2 rounded-xl border border-edge border-dashed p-10 text-center">
        {state.status === "idle" && (
          <p className="text-muted text-sm">Describe an app in the chat and it appears here.</p>
        )}

        {state.status === "starting" && (
          <>
            <span className="size-1.5 animate-pulse rounded-full bg-accent" aria-hidden="true" />
            <p className="text-muted text-sm">Starting the dev server…</p>
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
      <p className="text-ink text-sm">This project is put away.</p>
      <p className="text-muted text-xs">
        Its files are still saved. Starting it back up takes a few seconds.
      </p>

      <button
        type="button"
        onClick={() => onResume?.()}
        className="mt-2 rounded border border-accent px-3 py-1.5 font-medium text-accent text-xs hover:bg-accent/10 focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent"
      >
        Resume
      </button>

      {error !== undefined && (
        // A live region: it appears in response to a press, and a message that only changes
        // visually is one a screen reader never mentions.
        <p role="alert" className="mt-2 font-mono text-danger text-xs">
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
    <>
      <p className="text-ink text-sm">{copy.title}</p>
      <p className="font-mono text-danger text-xs">{copy.detail}</p>
      <p className="text-muted text-xs">{copy.action}</p>
    </>
  );
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/**
 * `resume` and the two flags beside it come from the shell rather than from a hook of this
 * pane's own: the file tree needs the same answer, and two hooks asking the same question would
 * be two requests and two chances to disagree about whether the project is running.
 */
export function LivePreviewPane({
  sessionId,
  putAway,
  onResume,
  resuming,
  resumeError,
}: {
  sessionId: string | undefined;
} & Omit<PreviewPaneProps, "events">) {
  const { events } = useEventStream({ sessionId });

  return (
    <PreviewPane
      events={events}
      {...(putAway === undefined ? {} : { putAway })}
      {...(onResume === undefined ? {} : { onResume })}
      {...(resuming === undefined ? {} : { resuming })}
      {...(resumeError === undefined ? {} : { resumeError })}
    />
  );
}
