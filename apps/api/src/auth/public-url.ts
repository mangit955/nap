/**
 * The auth library behind a proxy that publishes this API under a path.
 *
 * In production the browser reaches this API as `https://<web app>/backend/…`, which Vercel
 * forwards here with the prefix stripped — that is what makes the session cookie first-party
 * (`docs/DEPLOY.md` § One site for both halves). `NAP_API_URL` is that public address, and
 * better-auth builds OAuth redirect URIs from it, which is what sends a provider's callback back
 * through the proxy rather than to this host, where the cookie would not be.
 *
 * The library also *routes* on the path of its base URL, so it has to be shown the request as the
 * browser made it. Both halves are here so they cannot disagree; with no path in front of the API,
 * as in development, both are no-ops.
 */

const AUTH_PATH = "/api/auth";

/** Given explicitly, because the library takes a base URL with a path as the whole of it. */
export function authBaseUrl(apiUrl: string): string {
  return `${apiUrl.replace(/\/+$/, "")}${AUTH_PATH}`;
}

/** The request with the address the browser used, recovered from `NAP_API_URL`. */
export function asPublicRequest(request: Request, apiUrl: string): Request {
  const arrived = new URL(request.url);
  const target = new URL(`${apiUrl.replace(/\/+$/, "")}${arrived.pathname}${arrived.search}`);
  if (target.href === arrived.href) return request;
  return new Request(target.href, request);
}
