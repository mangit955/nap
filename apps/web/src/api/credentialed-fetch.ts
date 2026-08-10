/**
 * How this app talks to the API: with its cookies attached.
 *
 * The API is a different origin — a different port in development — so a browser leaves the
 * session cookie behind unless the request asks for it, and `credentials: "include"` is that
 * ask. Without it every call arrives unauthenticated, which looks exactly like being signed
 * out and is a genuinely confusing thing to debug.
 *
 * One place rather than a default per hook, because four copies of the same option is four
 * chances for one of them to be forgotten — and the one that is forgotten is the request that
 * mysteriously 401s. Each hook still takes an injected `fetch`, so tests never reach this.
 */

import type { FetchJson } from "../files/use-project-files.ts";

export const credentialedFetch: FetchJson = (url, init) =>
  fetch(url, { ...init, credentials: "include" });
