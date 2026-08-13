/**
 * The browser's half of authentication.
 *
 * Pointed at the API rather than at this app: the session cookie belongs to the API's origin,
 * because that is the origin every other request in this app is made to. The client sends
 * credentials on its own — it is built for exactly this — which is why nothing here repeats
 * the `credentials: "include"` that `credentialedFetch` adds to the hand-written calls.
 */

import { anonymousClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

const DEFAULT_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

/**
 * The `anonymous` plugin has to be listed on both ends.
 *
 * Registering it on the server creates the endpoint; registering it here is what puts
 * `signIn.anonymous` on this object. Miss this half and the demo button is a type error, which
 * is the good failure — the bad one would be a 404 at runtime.
 */
export const authClient = createAuthClient({
  baseURL: DEFAULT_BASE_URL,
  plugins: [anonymousClient()],
});

/**
 * Where to come back to once a provider has finished with us, and where an email sign-in lands.
 *
 * The key step rather than the dashboard: somebody who just made an account is the one person
 * who has not yet been asked whether they want to bring a key, and this is the only moment
 * where asking is not an interruption of something else. It skips itself for anybody who
 * already has one, and "just try it free" is always one click away — see `/welcome`.
 */
export const AFTER_SIGN_IN = "/welcome";

/**
 * Where the demo lands, which is straight to work.
 *
 * Deliberately not `AFTER_SIGN_IN`. Somebody who chose "without an account" has already
 * answered the question that page asks, and putting it in front of them anyway would turn
 * "try it" into "fill in a form" — which is the friction the demo door exists to remove.
 */
export const AFTER_DEMO_SIGN_IN = "/dashboard";

/**
 * Turns one of the paths above into somewhere a *provider* can send the browser back to.
 *
 * Email and demo sign-in return here and the router handles the rest, so a path is enough for
 * them. A social redirect leaves this app entirely and comes back through the API, which is
 * where the difference bites: the auth server resolves a relative `callbackURL` against its own
 * `baseURL`, so `/welcome` becomes `/welcome` *on the API's origin* — a route that only the
 * front end has, answered by the API's 404 as JSON. Passing the full URL makes the origin
 * explicit rather than inherited. It has to be in `trustedOrigins` on the server, and is:
 * `apps/api/src/index.ts` passes `NAP_WEB_ORIGIN`.
 */
export function returnTo(path: string): string {
  return new URL(path, window.location.origin).toString();
}
