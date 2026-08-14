/**
 * Whether a browser will treat this API's session cookie as a third-party one.
 *
 * The web app and the API are deployed to two different hosts — a Vercel domain and a
 * Railway one — which are separate sites as far as a browser is concerned. A cookie set by
 * one and sent to the other is therefore third-party, and the `SameSite=Lax` default means
 * it is never sent at all: sign-in appears to succeed and every request after it is a 401.
 *
 * Derived from the two URLs the process already knows rather than configured, because there
 * is no deployment where an operator would want to answer this differently from what those
 * two say — and a flag that can disagree with them is a flag that eventually does.
 *
 * Two things it deliberately does not do. It compares *hosts*, not sites, so a deployment
 * with the app on `nap.example.com` and the API on `api.example.com` is reported as
 * cross-site even though it is not; the answer is merely weaker than it needs to be, and
 * getting it exactly right means shipping the public suffix list. And it stays `false` for
 * anything not served over https, because `SameSite=None` is only honoured together with
 * `Secure`, which in turn cannot be set over a plain connection — reporting `true` there
 * would replace a cookie that works with one the browser refuses to store.
 */
export function isCrossSite(apiUrl: string, webOrigin: string): boolean {
  const api = new URL(apiUrl);
  const web = new URL(webOrigin);

  if (api.protocol !== "https:") return false;
  return api.hostname !== web.hostname;
}
