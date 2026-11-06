/**
 * Whether the sandbox a runtime call is about to work in still needs its `preview.ready`.
 *
 * One answer for every path that announces — a turn, `/compact`, a plan proposal, a resume and an
 * app test — so none of them can disagree with the others about what "announced" means.
 *
 * **A sandbox this call created is always announced.** The log may hold an older `preview.ready`,
 * but it names a sandbox that is gone.
 *
 * **A sandbox it found already running is announced only if the log never said so.** Saying it
 * twice remounts the preview frame under somebody using the app, on every turn. But the turn that
 * created a sandbox can end before its dev server answers — cancelled, or the dev server slower
 * than the runtime's timeout — and the announcement is then never written. Every later call finds
 * the sandbox running, so if this asked only "did I create it?", the pane would say "starting" for
 * the sandbox's whole life. A `preview.stopped` says the sandbox that was announced has gone, so
 * only an announcement after the last one counts.
 */

import type { StoredEvent } from "@nap/shared/ports/event-store";

export function shouldAnnouncePreview(options: {
  created: boolean;
  history: readonly StoredEvent[];
}): boolean {
  if (options.created) return true;
  for (let index = options.history.length - 1; index >= 0; index -= 1) {
    const type = options.history[index]?.type;
    if (type === "preview.ready") return false;
    if (type === "preview.stopped") return true;
  }
  return true;
}
