/**
 * An `ObjectStore` holding objects in a map.
 *
 * Snapshot and restore are otherwise untestable without a bucket, a network and credentials —
 * none of which belong in a suite that has to be free, deterministic and runnable offline.
 *
 * **It copies bytes in both directions.** A real store has serialized the payload by the time
 * `put` resolves, so a caller is free to reuse its buffer afterwards; a fake that kept the
 * caller's array would let a test pass against code that cannot work against R2. The same
 * applies on the way out — handing back the stored array lets one reader corrupt the store
 * for the next.
 *
 * `failWith` is what makes the data-loss guard testable: teardown must not destroy a sandbox
 * whose upload failed, and there is no other way to produce that failure on demand.
 */

import type { ObjectStore, ObjectStoreError } from "@nap/shared/ports/object-store";
import type { Result, VoidResult } from "@nap/shared/result";

export class InMemoryObjectStore implements ObjectStore {
  readonly #objects = new Map<string, Uint8Array>();
  #failure: ObjectStoreError | undefined;

  /** How many uploads were attempted, replacements included. */
  puts = 0;

  /** Makes every operation fail until called again with `undefined`. */
  failWith(error: ObjectStoreError | undefined): this {
    this.#failure = error;
    return this;
  }

  /** The keys currently held, sorted, so an assertion does not depend on write order. */
  keys(): string[] {
    return [...this.#objects.keys()].sort();
  }

  async put(key: string, bytes: Uint8Array): Promise<VoidResult<ObjectStoreError>> {
    this.puts += 1;
    if (this.#failure !== undefined) return { ok: false, error: this.#failure };

    this.#objects.set(key, Uint8Array.from(bytes));
    return { ok: true, value: undefined };
  }

  async get(key: string): Promise<Result<Uint8Array, ObjectStoreError>> {
    if (this.#failure !== undefined) return { ok: false, error: this.#failure };

    const found = this.#objects.get(key);
    if (found === undefined) {
      return { ok: false, error: { code: "not_found", message: `no object at ${key}` } };
    }

    return { ok: true, value: Uint8Array.from(found) };
  }

  async delete(key: string): Promise<VoidResult<ObjectStoreError>> {
    if (this.#failure !== undefined) return { ok: false, error: this.#failure };

    // Missing is success: the caller wanted it gone, and it is.
    this.#objects.delete(key);
    return { ok: true, value: undefined };
  }
}
