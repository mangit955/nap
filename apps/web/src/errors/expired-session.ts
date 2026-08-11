/**
 * Whether the sign-in page arrived at because a session ended, rather than because somebody
 * clicked "sign in".
 *
 * A pure function over the parameter value, so the decision is tested without a router and
 * without rendering a page. The two cases genuinely differ: one person is arriving, the other
 * was interrupted, and only the second is owed an explanation for why their work vanished.
 */

import { requestFailureCopy } from "./failure-copy.ts";

/** Set by `credentialedFetch` when the API answers 401. */
export const EXPIRED_PARAM = "expired";

/**
 * The notice to show, or nothing.
 *
 * `string[]` because a query string can repeat a key — `?expired=1&expired=1` is a real URL, and
 * Next hands that back as an array. Treated as present rather than as malformed: the user's
 * session did expire either way, and refusing to explain because the URL is odd helps nobody.
 */
export function expiredNotice(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;

  // The same words the chat would have shown, from the same place, so being told twice does not
  // mean being told two different things.
  const copy = requestFailureCopy(401, undefined, "");
  return `${copy.title} ${copy.action}`;
}
