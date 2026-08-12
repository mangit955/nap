/**
 * How long ago, in the roundest words that are still true.
 *
 * Exact timestamps are noise on a grid whose only job is "which one was I just in" — and a
 * localized absolute time would differ between the server render and the browser's, which React
 * reports as a hydration mismatch.
 */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));

  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86_400)}d ago`;
}
