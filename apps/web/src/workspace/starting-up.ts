/**
 * Whether the workspace should be showing a project coming up.
 *
 * A pure function because the interesting cases are *frames*, and frames are exactly what a
 * component test cannot see: rendering in jsdom flushes effects inside the same `act`, so the
 * gap this exists to close — between the paint and the effect that starts the project — never
 * happens there. Written down here, each case is checkable.
 *
 * The gap is real in a browser and it looked awful: the log says `preview.stopped` the moment
 * it arrives, so the preview pane drew the whole "This project is put away" screen, with a
 * button offering to do the thing that was already being done, for a frame or two on every
 * single open.
 *
 * Each clause covers a different moment:
 *
 *   - **`loading`** — the record has not arrived. Nothing is known, and the honest thing to show
 *     is that something is happening rather than a state derived from an empty log.
 *   - **`resuming`** — the request is out. This is the only clause the old version had.
 *   - **`putAwayAt` with no error** — the record says the project is not running and nothing has
 *     refused to start it, so a start is about to be asked for by the effect that has not run
 *     yet. This is the clause that closes the gap.
 *
 * And the reason the last one is qualified: a **refused** start (the sandbox quota answers 409)
 * leaves the record saying exactly the same thing, so without `resumeError` the pane would
 * claim forever to be starting a project that nothing is starting — hiding the one screen with
 * the button that could fix it.
 */

export type StartingUpInputs = {
  status: "loading" | "ready" | "missing" | "error";
  /** A start this page asked for is in flight. */
  resuming: boolean;
  /** When the server last said the project had no sandbox, if it says so now. */
  putAwayAt: string | undefined;
  /** Why the last start was refused, if it was. */
  resumeError: string | undefined;
};

export function isStartingUp({
  status,
  resuming,
  putAwayAt,
  resumeError,
}: StartingUpInputs): boolean {
  if (status === "loading") return true;
  if (resuming) return true;
  return putAwayAt !== undefined && resumeError === undefined;
}
