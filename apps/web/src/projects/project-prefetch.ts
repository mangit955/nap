/**
 * Asking for a project before anybody knows whether the page may see it.
 *
 * Opening `/p/<id>` used to be two round trips one after the other: the session check, and only
 * once it answered, the project. Both go from the page's host to the API's, so the second waited
 * out the whole of the first for nothing — a signed-in visitor's cookie is already on the request
 * either way. The frame therefore asks for the project while the session check is still in the
 * air, and the workspace, once it mounts, reads that answer rather than asking again.
 *
 * **An early answer is a hint, never the truth.** It was asked for before anybody knew there was a
 * session, so a refusal says nothing about now: anything but a record or a 404 is thrown away and
 * the workspace asks for itself, exactly as it did before. It is used once, for the one URL it was
 * asked for, and only while it is fresh, so a refresh — and a visit a minute later — are always
 * real requests.
 */

type Fetch = (url: string) => Promise<Response>;

/**
 * The early request's transport: the cookie, and nothing else.
 *
 * Not `credentialedFetch`, whose 401 sends the browser to "your session expired" — right for a
 * request made on behalf of a session somebody confirmed, wrong for one made before anybody
 * knew. An anonymous visitor opening a project would otherwise be redirected by a request that
 * was only ever a guess, before the session check that owns where they go had answered.
 */
const speculativeFetch: Fetch = (url) => fetch(url, { credentials: "include" });

/** Long enough for a slow session check, short enough that no record outlives the open it was for. */
const FRESH_FOR_MS = 15_000;

const DEFAULT_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

/** One slot: a page opens one project at a time, and an older early answer is nobody's. */
let early: { url: string; response: Promise<Response | undefined>; at: number } | undefined;

export function prefetchProject(
  projectId: string,
  options: { baseUrl?: string; fetchJson?: Fetch; now?: () => number } = {},
): void {
  const { baseUrl = DEFAULT_BASE_URL, fetchJson = speculativeFetch, now = Date.now } = options;
  const url = `${baseUrl}/projects/${projectId}`;
  if (early !== undefined && early.url === url && now() - early.at < FRESH_FOR_MS) return;

  // Settled here, so an early request that fails to arrive is never an unhandled rejection.
  early = { url, response: fetchJson(url).catch(() => undefined), at: now() };
}

/**
 * The project record at `url`: the early answer when there is a usable one for it, and a request
 * of its own otherwise. Either way the early answer is gone afterwards.
 */
export async function readProject(
  url: string,
  fetchJson: Fetch,
  now: () => number = Date.now,
): Promise<Response> {
  const candidate = early;
  if (candidate !== undefined && candidate.url === url) {
    early = undefined;
    if (now() - candidate.at < FRESH_FOR_MS) {
      const response = await candidate.response;
      if (response !== undefined && (response.ok || response.status === 404)) return response;
    }
  }
  return fetchJson(url);
}

/** Drops whatever was asked for early. Tests reset with it; nothing else needs to. */
export function forgetPrefetchedProject(): void {
  early = undefined;
}
