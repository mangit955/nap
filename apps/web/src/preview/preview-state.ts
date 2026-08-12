/**
 * What the preview pane should be showing, derived from the event log.
 *
 * The pane has exactly one job — show the user's app — and three ways of not doing it yet:
 * nothing has been asked for, a sandbox is coming up, or it failed to. Deriving that from the
 * same stream the chat renders keeps the two panes from disagreeing about what is happening.
 *
 * Two rules are worth stating because they are easy to get backwards:
 *
 *   - **A preview already on screen survives a later failure.** The app is still running; a
 *     turn that failed does not take it away, and blanking the pane would throw away the thing
 *     the user is looking at over an error the chat already explains.
 *   - **Only sandbox failures are preview failures.** `budget_exceeded`, `refusal` and
 *     `cancelled` are the agent stopping, and a pane claiming the sandbox died would be a lie.
 */

import type { NapEventOf } from "@nap/shared/events";
import type { StoredEvent } from "@nap/shared/ports/event-store";

type FailureReason = NapEventOf<"turn.failed">["payload"]["reason"];

/** The failures that mean "there is nothing to show", rather than "the agent gave up". */
const PREVIEW_FAILURES: readonly FailureReason[] = ["sandbox_unavailable", "internal"];

export type PreviewState =
  | { status: "idle" }
  | { status: "starting" }
  /**
   * `seq` identifies *which* announcement this is, which is what a reload keys on; `createdAt`
   * is when the server made it, which is what decides whether the project record read at mount
   * still has anything to say about it.
   */
  | { status: "ready"; url: string; port: number; seq: number; createdAt: string }
  /** The sandbox has been destroyed. The work is safe; there is just nothing serving it. */
  | { status: "stopped" }
  | { status: "error"; message: string };

export function previewState(events: readonly StoredEvent[]): PreviewState {
  let state: PreviewState = { status: "idle" };

  for (const event of events) {
    switch (event.type) {
      case "preview.ready":
        state = {
          status: "ready",
          url: event.payload.url,
          port: event.payload.port,
          seq: event.seq,
          createdAt: event.createdAt,
        };
        break;

      // Unconditional, unlike every other transition here: a ready preview is exactly what
      // this event invalidates. The address above it belongs to a sandbox that is gone, and
      // an iframe left pointing at it renders the provider's "not found" page as if it were
      // the user's app.
      case "preview.stopped":
        state = { status: "stopped" };
        break;

      case "user.message":
        // A new turn supersedes an old failure: the user has asked again, and the pane should
        // say it is working on it rather than keep showing what went wrong last time.
        if (state.status !== "ready") state = { status: "starting" };
        break;

      case "turn.failed":
        if (state.status !== "ready" && PREVIEW_FAILURES.includes(event.payload.reason)) {
          state = { status: "error", message: event.payload.message };
        }
        break;

      default:
        break;
    }
  }

  return state;
}

/**
 * Whether there is nothing serving this project — the log and the record read together.
 *
 * Two sources, and each knows something the other cannot. The **log** announces every close and
 * every sweep, so it is the better source and is usually enough. The **record** covers the one
 * gap in that: a sandbox the provider reclaims on its own timer is announced by nobody, so the
 * newest `preview.ready` can be an address that stopped answering an hour ago.
 *
 * **The record only outranks announcements older than itself**, which is the part that was
 * missing. `putAwayAt` is a moment the server had no sandbox; a `preview.ready` stamped after it
 * describes a sandbox created since, and a page that ignored that told everybody whose first
 * turn had just started that their project was filed away — while the header said `live` and the
 * transcript showed the address. Both timestamps are the server's own, so comparing them
 * involves no browser clock.
 */
export function isPutAway(events: readonly StoredEvent[], putAwayAt: string | undefined): boolean {
  const state = previewState(events);

  // The log said so outright; no record can be more current than an announcement.
  if (state.status === "stopped") return true;
  if (putAwayAt === undefined) return false;
  if (state.status !== "ready") return true;

  return Date.parse(state.createdAt) <= Date.parse(putAwayAt);
}
