import { ProviderSignInChallengeSchema } from "@nap/shared/ports/provider-sign-in-store";
import { describe, expect, it } from "vitest";
import { encryptionKeyFrom, seal } from "../account/secret-box.ts";
import { ProviderSecretBox } from "./secret-box.ts";

const KEY = encryptionKeyFrom(Buffer.alloc(32, 17).toString("base64"));
const USER = "00000000-0000-4000-8000-000000000001";
const ACCOUNT = "00000000-0000-4000-8000-000000000002";
const SESSION = "00000000-0000-4000-8000-000000000003";
const OTHER = "00000000-0000-4000-8000-000000000004";
const GRANT = {
  kind: "authorization",
  userId: USER,
  accountId: ACCOUNT,
  driver: "claude",
  generation: 3,
} as const;
const ATTEMPT = {
  kind: "attempt",
  userId: USER,
  accountId: ACCOUNT,
  authSessionId: SESSION,
  challengeHash: ProviderSignInChallengeSchema.parse("a".repeat(64)),
} as const;

describe("provider secret scope", () => {
  it("seals a private value with fresh nonces and opens only under its authenticated context", () => {
    const box = new ProviderSecretBox(KEY);
    const first = box.seal(GRANT, "private-refresh-grant");
    const second = box.seal(GRANT, "private-refresh-grant");
    expect(first.iv).not.toBe(second.iv);
    expect(JSON.stringify(first)).not.toContain("private-refresh-grant");
    expect(box.open(GRANT, first)).toEqual({ ok: true, value: "private-refresh-grant" });
    expect(
      box.open(
        {
          generation: 3,
          driver: "claude",
          accountId: ACCOUNT,
          userId: USER,
          kind: "authorization",
        },
        first,
      ),
    ).toEqual({ ok: true, value: "private-refresh-grant" });
    for (const scope of [
      { ...GRANT, userId: OTHER },
      { ...GRANT, accountId: OTHER },
      { ...GRANT, driver: "codex" as const },
      { ...GRANT, generation: 4 },
      ATTEMPT,
    ]) {
      expect(box.open(scope, first)).toEqual({ ok: false, reason: "scope_mismatch" });
    }
  });

  it("binds pending sign-in state to the initiating Nap session and challenge", () => {
    const box = new ProviderSecretBox(KEY);
    const state = box.seal(ATTEMPT, "private-pkce-verifier");
    expect(box.open(ATTEMPT, state)).toEqual({ ok: true, value: "private-pkce-verifier" });
    for (const scope of [
      { ...ATTEMPT, authSessionId: OTHER },
      { ...ATTEMPT, challengeHash: ProviderSignInChallengeSchema.parse("b".repeat(64)) },
      { ...ATTEMPT, userId: OTHER },
      { ...ATTEMPT, accountId: OTHER },
      GRANT,
    ]) {
      expect(box.open(scope, state)).toEqual({ ok: false, reason: "scope_mismatch" });
    }
  });

  it("rejects altered ciphertext, wrong keys and unscoped or unknown envelope formats without leaking plaintext", () => {
    const box = new ProviderSecretBox(KEY);
    const value = box.seal(GRANT, "secret-provider-grant");
    const bytes = Buffer.from(value.ciphertext, "base64");
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    expect(box.open(GRANT, { ...value, ciphertext: bytes.toString("base64") })).toEqual({
      ok: false,
      reason: "tampered",
    });
    expect(
      new ProviderSecretBox(encryptionKeyFrom(Buffer.alloc(32, 18).toString("base64"))).open(
        GRANT,
        value,
      ),
    ).toEqual({ ok: false, reason: "tampered" });
    for (const plaintext of [
      "private-plaintext-not-an-envelope",
      JSON.stringify({ version: 2, scope: GRANT, value: "private-value" }),
    ]) {
      const result = box.open(GRANT, seal(plaintext, KEY));
      expect(result).toEqual({ ok: false, reason: "malformed" });
      expect(JSON.stringify(result)).not.toContain("private");
    }
  });
});
