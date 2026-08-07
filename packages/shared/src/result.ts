/**
 * The shape every *expected* failure takes.
 *
 * A sandbox being unavailable, a file not existing, a budget running out — these are
 * outcomes, not bugs, and a caller must be forced to handle them. Exceptions are
 * reserved for programmer error, where the right response is a stack trace.
 *
 * Discriminated on `ok` so `if (result.ok)` narrows without a cast, and named to match
 * the `ok` field on the `tool.result` event, which carries the same idea to the client.
 */

export type Ok<T> = { ok: true; value: T };
export type Err<E> = { ok: false; error: E };

export type Result<T, E> = Ok<T> | Err<E>;

/** For operations that can fail but produce nothing on success. */
export type VoidResult<E> = Result<void, E>;
