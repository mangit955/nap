/**
 * Which URL each half of the form lives at.
 *
 * Its own module rather than a line inside `LiveSignIn`, for one reason: importing that file
 * constructs the Better Auth client, so a test of a two-branch mapping would pull a whole auth
 * client into the process to assert on a string.
 *
 * `/sign-in?mode=sign-up` still reaches the sign-up half — the query parameter is what the front
 * page linked to before this route existed, and links do not stop existing when a nicer one is
 * added. This is only what the address bar is *corrected* to.
 */

import type { SignInMode } from "./sign-in-form.tsx";

/**
 * `upgrade` carries a guest who came to make a permanent account: both halves keep it, since the
 * page sends any other signed-in visitor on, and a guest is signed in.
 */
export function pathForMode(mode: SignInMode, upgrade = false): string {
  return `${mode === "sign-up" ? "/sign-up" : "/sign-in"}${upgrade ? "?upgrade=1" : ""}`;
}
