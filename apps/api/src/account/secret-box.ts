/**
 * Sealing somebody else's API key so this deployment can spend it without ever storing it.
 *
 * AES-256-GCM, which is authenticated: opening a value that has been altered — a byte flipped
 * in a backup, a row edited by hand, a ciphertext moved from one user to another — *fails*
 * rather than returning plausible garbage that would then be sent to a vendor as a key. That
 * property is the whole reason for GCM over a bare cipher, and it is what the wrong-key test
 * pins.
 *
 * **A fresh IV per seal, never reused.** Reusing one under the same key is the failure mode
 * GCM has no tolerance for: two messages under one nonce leak their xor and, worse, let an
 * attacker forge tags. Twelve random bytes each time is the standard answer and the reason
 * `seal` takes no IV argument — there is no legitimate caller who should choose it.
 *
 * The tag is appended to the ciphertext rather than stored in a third column. It is not a
 * secret and it is meaningless apart from the bytes it authenticates, so a schema that could
 * hold one without the other buys nothing.
 *
 * Failure is a typed result, not an exception: a key that will not open is an expected state
 * once the encryption secret is rotated, and the caller has to be able to say so.
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Ciphertext and the nonce it was sealed under, both base64, as the store holds them. */
export type SealedSecret = {
  ciphertext: string;
  iv: string;
};

export type OpenResult =
  | { ok: true; value: string }
  | {
      ok: false;
      /**
       * `tampered` covers a wrong encryption secret as well as an altered ciphertext — GCM
       * cannot tell the two apart, and neither can anything above this.
       */
      reason: "malformed" | "tampered";
    };

/**
 * The 32 raw bytes behind `NAP_KEY_ENCRYPTION_SECRET`.
 *
 * A branded type rather than a bare `Buffer`, so a caller cannot pass the base64 *string* by
 * accident — that mistake type-checks, encrypts fine under a key derived from the wrong bytes,
 * and is only discovered when nothing decrypts.
 */
export type EncryptionKey = Buffer & { readonly __brand: "EncryptionKey" };

/**
 * Reads the configured secret into a key, refusing anything that is not exactly 32 bytes.
 *
 * Thrown rather than returned: this runs at boot from an already-validated env, so reaching a
 * bad value here is programmer error rather than an expected failure.
 */
export function encryptionKeyFrom(base64: string): EncryptionKey {
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length !== KEY_BYTES) {
    throw new Error(`encryption key must be ${KEY_BYTES} bytes, got ${bytes.length}`);
  }
  return bytes as EncryptionKey;
}

export function seal(plaintext: string, key: EncryptionKey): SealedSecret {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const sealed = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

  return {
    ciphertext: Buffer.concat([sealed, cipher.getAuthTag()]).toString("base64"),
    iv: iv.toString("base64"),
  };
}

export function open(secret: SealedSecret, key: EncryptionKey): OpenResult {
  const iv = Buffer.from(secret.iv, "base64");
  const raw = Buffer.from(secret.ciphertext, "base64");

  // Base64 decoding is famously forgiving — it discards anything it does not recognise rather
  // than complaining — so a truncated or non-base64 value arrives here as a short buffer
  // rather than as an error. Checking the lengths is what turns that into a stated reason.
  if (iv.length !== IV_BYTES || raw.length < TAG_BYTES) return { ok: false, reason: "malformed" };

  const tag = raw.subarray(raw.length - TAG_BYTES);
  const body = raw.subarray(0, raw.length - TAG_BYTES);

  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const opened = Buffer.concat([decipher.update(body), decipher.final()]);
    return { ok: true, value: opened.toString("utf8") };
  } catch {
    // `final()` throws when the tag does not match, which is the only way this fails once the
    // lengths are right. Swallowed deliberately: the exception's message says nothing an
    // operator can act on, and the reason above says everything they can.
    return { ok: false, reason: "tampered" };
  }
}

/**
 * Whether two secrets are the same, in constant time.
 *
 * Exported for the one caller that compares a key somebody just pasted against the one already
 * stored, so that "you already saved this key" does not need a re-verification round trip. A
 * `===` would leak the shared prefix through timing; the cost of using this instead is nothing.
 */
export function sameSecret(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // `timingSafeEqual` throws on a length mismatch, which is itself the answer — and lengths
  // are not the secret.
  return left.length === right.length && timingSafeEqual(left, right);
}
