/**
 * Everything this tab kept for the person who just signed out, dropped before the page moves on.
 *
 * One function for every sign-out button, because each thing kept here outlives the session that
 * made it: composer drafts in IndexedDB and `sessionStorage`, a start's prompt still on its way into the
 * workspace (`workspace/workspace-entry.ts`), and the event logs of projects
 * visited in this tab (`hooks/remembered-logs.ts`), which hold whole conversations. A second
 * sign-out path that clears its own list by hand is how one of them gets missed, so
 * `forget-signed-out-callers.test.ts` fails any file that signs out without calling this.
 */

import { forgetAllLogs } from "../hooks/remembered-logs.ts";
import { ComposerDraftStore } from "../projects/composer-draft.ts";
import { forgetWorkspaceEntry } from "../workspace/workspace-entry.ts";

export async function forgetSignedOut(
  ownerId: string | undefined,
  drafts: ComposerDraftStore = new ComposerDraftStore(),
): Promise<void> {
  forgetAllLogs();
  // A start in flight carries its prompt, which is the signed-out person's words.
  forgetWorkspaceEntry();
  if (ownerId === undefined) return;
  // A draft store that cannot open has nothing to clear, and must not hold up leaving.
  await drafts.clearOwner(ownerId).catch(() => {});
  sessionStorage.removeItem(`nap.composer.${ownerId}`);
}
