import { describe, expect, it } from "vitest";
import { SealedProviderCredentialsSchema } from "./provider-account-store.ts";
import { ProviderSignInAttemptSchema } from "./provider-sign-in-store.ts";

describe("provider sign-in attempt boundary", () => {
  const base = {
    flowId: "00000000-0000-4000-8000-000000000001",
    expiresAt: "2026-10-24T12:00:00.000Z",
  };
  it("keeps interactions only on the waiting phase and excludes private state", () => {
    expect(
      ProviderSignInAttemptSchema.parse({
        ...base,
        phase: "starting",
        interaction: null,
        message: null,
      }).phase,
    ).toBe("starting");
    expect(
      ProviderSignInAttemptSchema.parse({
        ...base,
        phase: "waiting",
        interaction: { type: "browser", url: "https://example.com/auth" },
        message: null,
      }).phase,
    ).toBe("waiting");
    for (const value of [
      { ...base, phase: "waiting", interaction: null, message: null },
      {
        ...base,
        phase: "succeeded",
        interaction: { type: "terminal", output: "old code" },
        message: null,
      },
      { ...base, phase: "failed", interaction: null, message: null },
      { ...base, phase: "verifying", interaction: null, message: null, ciphertext: "private" },
    ])
      expect(ProviderSignInAttemptSchema.safeParse(value).success).toBe(false);
  });
});

it("requires both nonempty sealed fields", () => {
  expect(SealedProviderCredentialsSchema.safeParse({ ciphertext: "", iv: "iv" }).success).toBe(
    false,
  );
  expect(SealedProviderCredentialsSchema.safeParse({ ciphertext: "sealed" }).success).toBe(false);
});
