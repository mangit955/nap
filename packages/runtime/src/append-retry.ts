/**
 * When an append is worth trying again, and how long to wait before doing so.
 *
 * On one process against one database a failed append is rare enough that treating it as fatal
 * costs nothing. Under concurrency it is routine — a pooled connection dropped, a serialization
 * failure, a database restarted underneath a live transaction — and each one currently kills a
 * whole turn along with its repair budget. See `docs/scaling-design.md` §17.
 *
 * The classification is a **whitelist**, and that is the load-bearing decision. Every failure
 * the runtime has not explicitly recognised as transient stays fatal, so a class nobody thought
 * about is retried zero times rather than three. The two that must never be retried — a unique
 * violation and a foreign key violation — are therefore fatal by default rather than by a rule
 * somebody has to remember to keep. A unique violation on `(session_id, seq)` means the
 * ordering guarantee itself broke; retrying it would bury that.
 *
 * Codes come from two places and both are checked. Postgres reports SQLSTATEs; postgres-js
 * reports its own string codes for a connection it could not use, including `CONNECT_TIMEOUT`
 * when waiting for one exceeds the timeout. Drizzle wraps whichever arrives in a
 * `Failed query: …` error and puts the original on `.cause`, so the chain is walked rather
 * than the top-level error read.
 */

/** Transient SQLSTATEs: serialization failure, deadlock, admin shutdown. */
const TRANSIENT_SQLSTATES = new Set(["40001", "40P01", "57P01"]);

/**
 * Transient driver codes: a connection that went away, and one that never arrived.
 *
 * The first four are postgres-js's own; the rest are the socket errnos it passes through
 * unchanged when the network, rather than the driver, is what gave up.
 */
const TRANSIENT_DRIVER_CODES = new Set([
  "CONNECTION_CLOSED",
  "CONNECTION_DESTROYED",
  "CONNECTION_ENDED",
  "CONNECT_TIMEOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
]);

/** How many times an append is tried in total, the first attempt included. */
export const APPEND_ATTEMPTS = 3;

/** The first wait; each one after it is four times the last. */
const FIRST_BACKOFF_MS = 100;

/** How far either side of the nominal wait a delay may land. */
const JITTER = 0.25;

function codeOf(error: unknown): string | null {
  if (typeof error !== "object" || error === null) return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

/** Whether trying this append again could plausibly succeed. */
export function isTransientAppendFailure(error: unknown): boolean {
  // A cause chain rather than one hop: drizzle wraps the driver, and the driver may itself be
  // wrapping the socket.
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current !== null && current !== undefined; depth += 1) {
    const code = codeOf(current);
    if (code !== null && (TRANSIENT_SQLSTATES.has(code) || TRANSIENT_DRIVER_CODES.has(code))) {
      return true;
    }
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : null;
  }
  return false;
}

/**
 * How long to wait before attempt `attempt + 1`, jittered.
 *
 * Jitter is not decoration: every turn that lost the same pooled connection failed at the same
 * moment, and without it they all come back at the same moment too, turning one blip into a
 * sustained one. `random` is a parameter so the schedule can be asserted exactly.
 */
export function appendBackoffMs(attempt: number, random: () => number = Math.random): number {
  const nominal = FIRST_BACKOFF_MS * 4 ** (attempt - 1);
  return Math.round(nominal * (1 - JITTER + 2 * JITTER * random()));
}
