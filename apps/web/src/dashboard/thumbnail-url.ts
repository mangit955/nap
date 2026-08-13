/**
 * Where a project's picture is served from.
 *
 * A plain URL rather than a hook: the browser is perfectly capable of fetching an image, and
 * the alternative — fetch, blob, object URL, revoke on unmount — is four things to get wrong
 * per card in exchange for nothing.
 *
 * **The version is what makes caching safe.** The bytes at that key are replaced whenever a
 * turn changes the project, so a bare URL would show yesterday's app until the browser felt
 * like asking again. `updatedAt` moves on exactly the turns that replace the picture, which
 * lets the response be cached forever and still be right.
 */

const DEFAULT_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

export function thumbnailUrl(projectId: string, updatedAt: string, baseUrl = DEFAULT_BASE_URL) {
  return `${baseUrl}/projects/${projectId}/thumbnail?v=${encodeURIComponent(updatedAt)}`;
}
