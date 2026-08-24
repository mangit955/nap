/**
 * The two clocks the sandbox ceiling runs on, in one place because they have to agree.
 *
 * A reservation may hold a slot for `RESERVATION_TTL_MS` before it has created anything, and a
 * sweep waits `STRANDED_GRACE_MS` before deciding that a sandbox nothing references, or a row
 * naming a sandbox nothing holds, is a leak rather than work in flight.
 *
 * **The second must be longer than the first**, and that is the whole reason they are neighbours
 * rather than a constant each in the two files that use them. If a sweep were the quicker of the
 * two it would reclaim slots and destroy sandboxes belonging to creations that are still perfectly
 * healthy — a race between the thing enforcing the ceiling and the thing repairing it, won
 * occasionally by the repair. `capacity-windows.test.ts` asserts the ordering, since nothing else
 * would notice it being edited away.
 *
 * They live in `shared` rather than in `@nap/db` because the admission path reads one and the
 * reconciling sweep in `@nap/runtime` reads the other, and neither package may import the other's
 * internals.
 */

/**
 * How long a `reserved` row may hold capacity before anything has been created against it.
 *
 * Several times a sandbox cold start and a small fraction of an hour's billing: long enough that
 * a slow creation is never cut off mid-flight, short enough that a process dying at the wrong
 * moment costs minutes of one slot rather than a permanently smaller ceiling.
 */
export const RESERVATION_TTL_MS = 2 * 60 * 1000;

/**
 * How old something must be before a sweep believes nothing will ever come back for it.
 *
 * Comfortably past `RESERVATION_TTL_MS`, so that by the time anything is destroyed the row that
 * reserved it has already expired and been reclaimed — the two rules agree about which sandboxes
 * are dead instead of racing.
 */
export const STRANDED_GRACE_MS = 5 * 60 * 1000;
