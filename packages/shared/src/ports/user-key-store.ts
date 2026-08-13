/**
 * Where somebody's own API key is kept between visits.
 *
 * **This port handles ciphertext and never a key.** Encryption belongs to the layer that has
 * the encryption secret — `apps/api/src/account/secret-box.ts` — and keeping the seal outside
 * the store is what guarantees the database, its backups and its query log only ever hold
 * bytes nobody there can read. A store that took a plaintext key and encrypted it internally
 * would type-check identically and put the key in one more place.
 *
 * At most one key per person, so `put` replaces rather than appends: "which key am I using?"
 * has to have exactly one answer at the moment a turn is billed.
 */

/** What is stored, as stored. `hint` is the only field meant to be shown to anyone. */
export type StoredKeyRecord = {
  userId: string;
  platform: "openrouter" | "anthropic";
  /** Base64 AES-GCM ciphertext with its auth tag appended. Opaque here. */
  ciphertext: string;
  /** Base64, fresh per write. */
  iv: string;
  /** A masked tail — `sk-or-…4f2a` — so a person can recognise their own key. */
  hint: string;
  updatedAt: string;
};

export type NewStoredKey = Omit<StoredKeyRecord, "updatedAt">;

export interface UserKeyStore {
  /** Null when this person has never saved one, which is the ordinary free-tier state. */
  get(userId: string): Promise<StoredKeyRecord | null>;

  /** Saves, replacing whatever was there. */
  put(key: NewStoredKey): Promise<StoredKeyRecord>;

  /** Forgets it. Silent when there was nothing to forget — removing twice is not an error. */
  remove(userId: string): Promise<void>;
}
