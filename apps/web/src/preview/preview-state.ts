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
  /** `seq` identifies *which* announcement this is, which is what a reload keys on. */
  | { status: "ready"; url: string; port: number; seq: number }
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
