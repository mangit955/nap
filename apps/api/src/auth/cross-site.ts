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
 * It stays `false` for anything not served over https, because `SameSite=None` is only
 * honoured together with `Secure`, which in turn cannot be set over a plain connection —
 * reporting `true` there would replace a cookie that works with one the browser refuses to
 * store.
 */
export function isCrossSite(apiUrl: string, webOrigin: string): boolean {
  const api = new URL(apiUrl);
  const web = new URL(webOrigin);

  if (api.protocol !== "https:") return false;
  return !sameRegistrableDomain(api.hostname, web.hostname);
}

/**
 * Hosting suffixes under which every customer gets a subdomain, so two of them are different
 * sites however much of the name they share.
 *
 * These are the two this project deploys to, not an attempt at the list. They are here
 * because getting one of them wrong is the expensive direction: a false `same site` drops
 * the cookie back to `SameSite=Lax`, which stops sign-in working in *every* browser rather
 * than in the third-party-blocking ones alone.
 */
const HOSTING_SUFFIXES = ["vercel.app", "railway.app"];

/**
 * Whether two hostnames are the same site, near enough for the deployments this runs in.
 *
 * The real rule is "equal registrable domains", which needs the public suffix list to
 * answer in general — a megabyte of data and a lookup, to decide one cookie attribute. This
 * approximates it: identical hosts, one a subdomain of the other, or a shared last two
 * labels. That is exact for the shape this is asked about — an app and an API placed under
 * one domain an operator owns — and wrong for multi-label public suffixes, where it would
 * call two unrelated tenants of `example.co.uk` the same site. `HOSTING_SUFFIXES` covers the
 * two such suffixes this project actually meets; the rest of that class remains a known and
 * accepted gap.
 *
 * An address is not a name, so two hosts reached by IP are only the same site when they are
 * the same host — otherwise `192.168.0.1` and `10.0.0.1` would share the labels `0.1`.
 */
function sameRegistrableDomain(a: string, b: string): boolean {
  if (a === b) return true;
  if (isAddressLiteral(a) || isAddressLiteral(b)) return false;

  // A bare hosting suffix is nobody's deployment, and treating one as the parent of a tenant
  // would walk around the guard below rather than through it.
  if (HOSTING_SUFFIXES.includes(a) || HOSTING_SUFFIXES.includes(b)) return false;
  if (a.endsWith(`.${b}`) || b.endsWith(`.${a}`)) return true;

  const parent = lastTwoLabels(a);
  if (parent !== lastTwoLabels(b)) return false;
  return !HOSTING_SUFFIXES.includes(parent);
}

function lastTwoLabels(hostname: string): string {
  return hostname.split(".").slice(-2).join(".");
}

function isAddressLiteral(hostname: string): boolean {
  // URL normalises an IPv6 host to bracketed form, and an IPv4 one has no letters in it.
  return hostname.startsWith("[") || !/[a-z]/i.test(hostname);
}
