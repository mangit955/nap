/**
 * Where the auth client sends its requests.
 *
 * Given explicitly, because the client takes a base URL that has a path as the whole of it — and
 * in production the API *has* one: the page reaches it as `/backend` on this app's own origin, so
 * the session cookie is first-party in every browser (`docs/DEPLOY.md` § One site for both
 * halves). The API builds the same address the same way, in `apps/api/src/auth/public-url.ts`.
 */
export function authBaseUrl(apiUrl: string): string {
  return `${apiUrl.replace(/\/+$/, "")}/api/auth`;
}
