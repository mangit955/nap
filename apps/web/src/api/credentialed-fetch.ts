/**
 * How this app talks to the API: with its cookies attached, and knowing what to do when they
 * are not enough.
 *
 * The API is a different origin — a different port in development — so a browser leaves the
 * session cookie behind unless the request asks for it, and `credentials: "include"` is that
 * ask. Without it every call arrives unauthenticated, which looks exactly like being signed
 * out and is a genuinely confusing thing to debug.
 *
 * One place rather than a default per hook, because four copies of the same option is four
 * chances for one of them to be forgotten — and the one that is forgotten is the request that
 * mysteriously 401s. Each hook still takes an injected `fetch`, so tests never reach this.
 *
 * **A 401 sends the browser to the sign-in page.** Every guarded route in the API answers that
 * way to a caller it does not recognise, and the honest response to "you are not signed in" is
 * to offer signing in — not an error message about a project list that was never going to load.
 * The response is still handed back, so a caller mid-render is not left waiting on a promise
 * that never settles while the navigation happens.
 */

import type { FetchJson } from "../files/use-project-files.ts";

export const SIGN_IN_PATH = "/sign-in";

/**
 * Where a 401 sends the browser.
 *
 * The parameter is the whole difference between a redirect and an explanation. Without it the
 * page simply vanishes mid-session and reappears as a sign-in form, which is indistinguishable
 * from having clicked "sign out" by accident — and is worse than the bare spinner this is all
 * meant to remove, because at least a spinner does not pretend nothing happened.
 */
export const EXPIRED_SIGN_IN_PATH = `${SIGN_IN_PATH}?expired=1`;

/**
 * Whether a 401 should move the browser.
 *
 * Not while already on the sign-in page: the sign-in request itself 401s on a wrong password,
 * and redirecting to the page you are on throws away what you typed and looks like the form
 * silently resetting itself.
 */
export function shouldRedirectToSignIn(status: number, pathname: string): boolean {
  return status === 401 && pathname !== SIGN_IN_PATH;
}

export const credentialedFetch: FetchJson = async (url, init) => {
  const response = await fetch(url, { ...init, credentials: "include" });

  if (shouldRedirectToSignIn(response.status, globalThis.location?.pathname ?? SIGN_IN_PATH)) {
    globalThis.location.assign(EXPIRED_SIGN_IN_PATH);
  }

  return response;
};
