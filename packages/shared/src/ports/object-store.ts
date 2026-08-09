/**
 * Where a project's bytes live when no sandbox is holding them.
 *
 * A sandbox is billed by the second and does not survive being idle, so a project that
 * nobody is looking at exists only as a git bundle in object storage. This is the seam that
 * bundle goes through: R2 in production, a map in tests, and — the reason it is a port at
 * all — anything S3-compatible after that, since the only operations here are the three every
 * object store has.
 *
 * Deliberately not a filesystem. No listing, no directories, no partial reads: a key names a
 * whole object and objects are written once and replaced whole. Everything richer than that
 * would have to be implemented by every adapter, and nothing in this system needs it.
 *
 * Failures are values for the same reason they are on `SandboxManager`. An upload failing is
 * an ordinary outcome of talking to a network service, and the caller that must not proceed
 * to destroy a sandbox afterwards should fail to compile if it forgets to check.
 */

import type { Result, VoidResult } from "../result.ts";

export type ObjectStoreErrorCode =
  /** No object at that key. Distinct from a failure to reach the store at all. */
  | "not_found"
  /** The store could not be reached, or refused the request. */
  | "unavailable";

export type ObjectStoreError = {
  code: ObjectStoreErrorCode;
  message: string;
};

export interface ObjectStore {
  /** Writes an object, replacing whatever was at that key. */
  put(key: string, bytes: Uint8Array): Promise<VoidResult<ObjectStoreError>>;

  get(key: string): Promise<Result<Uint8Array, ObjectStoreError>>;

  /**
   * Removes an object. Deleting a key that does not exist **succeeds**: the caller's intent
   * is that the object be gone, and a project being deleted must not fail because one of its
   * snapshots was already cleaned up.
   */
  delete(key: string): Promise<VoidResult<ObjectStoreError>>;
}
