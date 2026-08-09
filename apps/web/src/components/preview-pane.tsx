"use client";

import type { StoredEvent } from "@nap/shared/ports/event-store";
import { useState } from "react";
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

export function PreviewPane({ events }: { events: readonly StoredEvent[] }) {
  const state = previewState(events);
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
        <Waiting state={state} />
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

/** Everything that is not the app: nothing asked for yet, still coming up, or broken. */
function Waiting({ state }: { state: Exclude<PreviewState, { status: "ready" }> }) {
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

        {state.status === "error" && (
          <>
            <p className="text-ink text-sm">The sandbox didn't start.</p>
            <p className="font-mono text-danger text-xs">{state.message}</p>
            {/* An error names the way out, or the only thing left to try is reloading the page. */}
            <p className="text-muted text-xs">Send another message to try again.</p>
          </>
        )}
      </div>
    </div>
  );
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Until sessions exist in the UI, the id comes from the environment — see the hook. */
const DEV_SESSION_ID = process.env.NEXT_PUBLIC_DEV_SESSION_ID;

export function LivePreviewPane() {
  const { events } = useEventStream({ sessionId: DEV_SESSION_ID });

  return <PreviewPane events={events} />;
}
