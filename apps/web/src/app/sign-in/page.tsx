import { LiveSignIn } from "../../auth/live-sign-in.tsx";
import { EXPIRED_PARAM, expiredNotice } from "../../errors/expired-session.ts";

/**
 * The way in — and the place a session that has expired lands, since every route needs one.
 *
 * Those two arrivals are different. One person came here to sign in; the other was working, and
 * the page went out from under them. The second is owed a sentence saying why, which is what the
 * `expired` parameter carries.
 *
 * **`searchParams` is a Promise in this version of Next** — verified in
 * `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/page.md`, not
 * recalled; older versions hand back a plain object and awaiting one is the difference between
 * this working and rendering nothing.
 */
export default async function Page({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const params = await searchParams;

  return <LiveSignIn notice={expiredNotice(params[EXPIRED_PARAM])} />;
}
