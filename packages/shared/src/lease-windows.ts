/**
 * The three clocks a per-session lease runs on, in one place because they have to agree.
 *
 * A worker holds a lease for `LEASE_TTL_MS` and pushes that out every `LEASE_RENEWAL_INTERVAL_MS`.
 * `LEASE_GRACE_MS` is the margin the janitor waits *past* expiry before reclaiming the row.
 *
 * **The ordering is the fencing.** Renewal is conditional, so a worker that has lost its lease
 * learns within one renewal interval and aborts — by `expiry + LEASE_RENEWAL_INTERVAL_MS` at the
 * latest. The janitor acts only at `expiry + LEASE_GRACE_MS`, which is later, so by the time a
 * session can be claimed again the previous worker has certainly stopped writing to it. Two
 * concurrent writers to one session are unreachable because of that gap and nothing else, which is
 * why the three numbers are neighbours rather than a constant each in three files.
 * `lease-windows.test.ts` asserts the ordering, since nothing else would notice it being edited
 * away.
 *
 * They live in `shared` because the queue in `@nap/db` reads two of them, the worker loop in
 * `@nap/runtime` reads the third, and neither package may import the other's internals.
 */

/**
 * How long a claim is good for without being renewed.
 *
 * Four renewal intervals, so a worker tolerates three consecutive missed renewals — a Postgres
 * blip or a long pause — before anything else can take its session.
 */
export const LEASE_TTL_MS = 60 * 1000;

/**
 * How often a worker asks whether it still holds its lease.
 *
 * Also how quickly it hears about a cancellation, because one statement answers both: a worker
 * asking "am I still allowed to run?" is asking exactly one question.
 */
export const LEASE_RENEWAL_INTERVAL_MS = 15 * 1000;

/**
 * How long past expiry the janitor waits before calling a lease abandoned.
 *
 * Longer than a renewal interval, so the window between "the worker has certainly aborted" and
 * "the row is reclaimable" never closes to zero.
 */
export const LEASE_GRACE_MS = 30 * 1000;
