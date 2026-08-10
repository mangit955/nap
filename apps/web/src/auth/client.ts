/**
 * The browser's half of authentication.
 *
 * Pointed at the API rather than at this app: the session cookie belongs to the API's origin,
 * because that is the origin every other request in this app is made to. The client sends
 * credentials on its own — it is built for exactly this — which is why nothing here repeats
 * the `credentials: "include"` that `credentialedFetch` adds to the hand-written calls.
 */

import { createAuthClient } from "better-auth/react";

const DEFAULT_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export const authClient = createAuthClient({ baseURL: DEFAULT_BASE_URL });

/** Where to come back to once GitHub has finished with us. */
export const AFTER_SIGN_IN = "/";
