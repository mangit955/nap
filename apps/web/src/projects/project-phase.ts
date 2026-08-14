/**
 * What a project is doing, as one answer.
 *
 * Two sources describe it and neither is sufficient. The **record** is a row read once, when the
 * workspace opened: it knows whether the server thought a sandbox was serving, and it goes stale
 * the moment a turn creates one. The **log** is live and knows the address, but arrives after the
 * record and says nothing at all about a sandbox the provider reclaimed on its own timer. Add the
 * request this page has made and has not heard back about, and there are three things to reconcile.
 *
 * They used to be reconciled in five places — a boolean in the shell, an override in the preview
 * pane, another in the file tree, a comparison in `preview-state.ts`, and a wait in
 * `use-projects.ts` — with the rule written out in four separate doc comments, each reading as
 * authoritative. Two bugs lived in the gaps: the put-away screen flashing on every open, and a
 * running project announcing that nothing was running for the two seconds before its log arrived.
 *
 * **The precedence below is the interface.** A caller needs to know the order to predict what it
 * will get, so the order is stated once, here, and every clause says which fact it defends.
 */

import { type ProjectSummaryPayload, projectState } from "@nap/shared/projects-protocol";
import type { PreviewState } from "../preview/preview-state.ts";

export type ProjectPhase =
  /** Nothing knowable yet: the record is in flight, or the log of a running project is. */
  | { kind: "opening" }
  /** Nothing has ever run here. The pane invites a first prompt. */
  | { kind: "idle" }
  /** A sandbox is coming up, or is about to be asked for. */
  | { kind: "starting" }
  /**
   * Something is serving the project. `seq` travels with the address because a reload keys on it:
   * a project put away and restarted has two announcements in its log and one live sandbox.
   */
  | { kind: "running"; url: string; seq: number }
  /** Nothing is serving it. The work is safe; the pane offers to start it again. */
  | { kind: "put-away" }
  /** A sandbox was wanted and could not be had. */
  | { kind: "failed"; message: string };

export type PhaseInputs = {
  /** How the record fetch is going. */
  status: "loading" | "ready" | "missing" | "error";
  /** What the record itself says, via the one function that reads a row this way. */
  record: "running" | "put away" | "new" | undefined;
  /**
   * The instant the server last had no sandbox, or `undefined` once this page has started the
   * project. An instant rather than a flag so it can be compared against an announcement.
   */
  putAwayAt: string | undefined;
  /** What the log says. */
  preview: PreviewState;
  /** Whether the server has said it sent the whole log yet. */
  replayed: boolean;
  /** A start this page asked for is in flight, or waiting to be announced. */
  resuming: boolean;
  /** Why the last start was refused, if it was. */
  resumeError: string | undefined;
};

export function phaseOf({
  status,
  record,
  putAwayAt,
  preview,
  replayed,
  resuming,
  resumeError,
}: PhaseInputs): ProjectPhase {
  // Nothing is known. Deriving a state from an empty log here is how the pane came to announce
  // "Nothing running yet" about a project that was running.
  if (status === "loading") return { kind: "opening" };

  // A project deleted in another tab. The header says so in words; a pane waiting forever
  // underneath that sentence would contradict it. Note that `error` deliberately falls through:
  // the record fetch failing does not stop the socket, and blanking an app somebody is watching
  // over a failed background request is worse than a header that admits the server is unreachable.
  if (status === "missing") return { kind: "idle" };

  if (resuming) return { kind: "starting" };

  // The gap between the record arriving and the effect that acts on it. The record says the
  // project is not running and nothing has refused to start it, so a start is about to be asked
  // for — and without this the pane draws the whole put-away screen, button included, offering to
  // do the thing that is already being done. The `resumeError` qualifier is what stops it claiming
  // forever to be starting a project that nothing is starting: a refusal leaves the record saying
  // exactly the same thing.
  if (putAwayAt !== undefined && resumeError === undefined) return { kind: "starting" };

  if (nothingIsServing(preview, putAwayAt)) return { kind: "put-away" };

  // The record says a sandbox is serving and the announcement naming it has not arrived. There is
  // nothing to point an iframe at and nothing to invite, so the honest answer is a wait — this is
  // the two-second window in which a running project used to claim to be empty.
  if (record === "running" && !replayed) return { kind: "opening" };

  switch (preview.status) {
    case "error":
      return { kind: "failed", message: preview.message };
    case "ready":
      return { kind: "running", url: preview.url, seq: preview.seq };
    case "starting":
      return { kind: "starting" };
    default:
      return { kind: "idle" };
  }
}

/**
 * Whether nothing is serving the project — the log and the record read together.
 *
 * Each source knows something the other cannot. The **log** announces every close and every sweep,
 * so it is the better source and usually enough. The **record** covers the one gap in that: a
 * sandbox the provider reclaimed on its own timer is announced by nobody, so the newest
 * `preview.ready` can be an address that stopped answering an hour ago.
 *
 * **The record only outranks announcements older than itself.** `putAwayAt` is a moment the server
 * had no sandbox; a `preview.ready` stamped after it describes a sandbox created since, and a page
 * that ignored that told everybody whose first turn had just started that their project was filed
 * away — while the header said `live` and the transcript showed the address. Both timestamps are
 * the server's own, so comparing them involves no browser clock.
 */
function nothingIsServing(preview: PreviewState, putAwayAt: string | undefined): boolean {
  // The log said so outright; no record can be more current than an announcement.
  if (preview.status === "stopped") return true;
  if (putAwayAt === undefined) return false;
  if (preview.status !== "ready") return true;

  return Date.parse(preview.createdAt) <= Date.parse(putAwayAt);
}

/** What the record says on its own, for the callers that hold one. `undefined` when none has arrived. */
export function recordState(
  project: ProjectSummaryPayload | undefined,
): "running" | "put away" | "new" | undefined {
  return project === undefined ? undefined : projectState(project);
}
