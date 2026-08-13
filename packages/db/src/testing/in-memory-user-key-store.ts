/**
 * A `UserKeyStore` holding rows in a map.
 *
 * Every route test that decides which models a caller may reach needs to say "this person has
 * a key" or "this person does not", and none of them should start a database to say it.
 *
 * Records are handed back as copies, and `updatedAt` advances by a counter rather than by the
 * clock: two writes in the same millisecond would otherwise be indistinguishable in a test
 * asserting that replacing a key moved the date.
 */

import type { NewStoredKey, StoredKeyRecord, UserKeyStore } from "@nap/shared/ports/user-key-store";

export class InMemoryUserKeyStore implements UserKeyStore {
  readonly #rows = new Map<string, StoredKeyRecord>();
  #sequence = 0;

  async get(userId: string): Promise<StoredKeyRecord | null> {
    const found = this.#rows.get(userId);
    return found === undefined ? null : { ...found };
  }

  async put(key: NewStoredKey): Promise<StoredKeyRecord> {
    this.#sequence += 1;
    const row: StoredKeyRecord = {
      ...key,
      updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, this.#sequence)).toISOString(),
    };

    this.#rows.set(key.userId, row);
    return { ...row };
  }

  async remove(userId: string): Promise<void> {
    this.#rows.delete(userId);
  }
}
