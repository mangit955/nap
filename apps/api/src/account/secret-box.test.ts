import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encryptionKeyFrom, open, sameSecret, seal } from "./secret-box.ts";

const KEY = encryptionKeyFrom(randomBytes(32).toString("base64"));
const OTHER_KEY = encryptionKeyFrom(randomBytes(32).toString("base64"));

describe("encryptionKeyFrom", () => {
  it("reads 32 base64 bytes", () => {
    expect(encryptionKeyFrom(randomBytes(32).toString("base64"))).toHaveLength(32);
  });

  it("refuses a secret that is not 32 bytes", () => {
    // The realistic mistake is a short hand-typed value, which would otherwise be accepted by
    // `createCipheriv` never — but only at the first save, long after boot.
    expect(() => encryptionKeyFrom(randomBytes(16).toString("base64"))).toThrow(/32 bytes/);
  });
});

describe("seal and open", () => {
  it("round-trips a key", () => {
    const sealed = seal("sk-or-v1-abcdef", KEY);

    expect(open(sealed, KEY)).toEqual({ ok: true, value: "sk-or-v1-abcdef" });
  });

  it("does not leave the plaintext anywhere in what it stores", () => {
    const sealed = seal("sk-or-v1-abcdef", KEY);

    expect(sealed.ciphertext).not.toContain("sk-or");
    expect(sealed.iv).not.toContain("sk-or");
  });

  it("uses a fresh nonce every time, so the same key seals differently twice", () => {
    const first = seal("sk-or-v1-abcdef", KEY);
    const second = seal("sk-or-v1-abcdef", KEY);

    // Reusing a nonce under one key is the failure AES-GCM has no tolerance for. Two identical
    // ciphertexts for one plaintext is exactly what that looks like from outside.
    expect(second.iv).not.toEqual(first.iv);
    expect(second.ciphertext).not.toEqual(first.ciphertext);
  });

  it("refuses to open under a different encryption secret", () => {
    const sealed = seal("sk-or-v1-abcdef", KEY);

    // The point of an authenticated cipher: a wrong secret fails loudly rather than handing
    // back plausible garbage that would then be sent to a vendor as somebody's key.
    expect(open(sealed, OTHER_KEY)).toEqual({ ok: false, reason: "tampered" });
  });

  it("refuses a ciphertext whose bytes have been altered", () => {
    const sealed = seal("sk-or-v1-abcdef", KEY);
    const bytes = Buffer.from(sealed.ciphertext, "base64");
    bytes[0] = (bytes[0] ?? 0) ^ 0xff;

    expect(open({ ...sealed, ciphertext: bytes.toString("base64") }, KEY)).toEqual({
      ok: false,
      reason: "tampered",
    });
  });

  it("calls a truncated or non-base64 value malformed rather than throwing", () => {
    // Base64 decoding discards what it does not recognise instead of complaining, so garbage
    // arrives as a short buffer rather than as an error.
    expect(open({ ciphertext: "!!!", iv: "!!!" }, KEY)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("sameSecret", () => {
  it("is true for equal secrets and false otherwise", () => {
    expect(sameSecret("sk-or-abc", "sk-or-abc")).toBe(true);
    expect(sameSecret("sk-or-abc", "sk-or-abd")).toBe(false);
  });

  it("answers false rather than throwing on a length mismatch", () => {
    // `timingSafeEqual` throws when the buffers differ in length; lengths are not the secret,
    // so the guard in front of it is what keeps this a comparison rather than a crash.
    expect(sameSecret("short", "much longer value")).toBe(false);
  });
});
