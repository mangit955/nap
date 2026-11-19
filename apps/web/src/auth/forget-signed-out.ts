/**
 * Everything this tab kept for the person who just signed out, dropped before the page moves on.
 *
 * One function for every sign-out button, because each thing kept here outlives the session that
 * made it: composer drafts in IndexedDB and `sessionStorage`, the event logs of projects
 * visited in this tab (`hooks/remembered-logs.ts`), which hold whole conversations, the project
 * records this tab has seen (`projects/known-projects.ts`), and the account's models and key
 * (`account/account-cache.ts`). A second
 * sign-out path that clears its own list by hand is how one of them gets missed, so
 * `forget-signed-out-callers.test.ts` fails any file that signs out without calling this.
 */

import { forgetAccount } from "../account/account-cache.ts";
import { forgetAllLogs } from "../hooks/remembered-logs.ts";
import { ComposerDraftStore } from "../projects/composer-draft.ts";
import { forgetKnownProjects } from "../projects/known-projects.ts";

export async function forgetSignedOut(
  ownerId: string | undefined,
  drafts: ComposerDraftStore = new ComposerDraftStore(),
): Promise<void> {
  forgetAllLogs();
  forgetKnownProjects();
  forgetAccount();
  if (ownerId === undefined) return;
  // A draft store that cannot open has nothing to clear, and must not hold up leaving.
  await drafts.clearOwner(ownerId).catch(() => {});
  sessionStorage.removeItem(`nap.composer.${ownerId}`);
}
