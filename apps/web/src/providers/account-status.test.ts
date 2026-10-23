import type { ProviderAccountView } from "@nap/shared/provider-accounts-protocol";
import { describe, expect, it } from "vitest";
import { accountStatus, isSigningIn } from "./account-status.ts";

const ACCOUNT: ProviderAccountView = {
  id: "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f",
  driver: "claude",
  label: null,
  enabled: true,
  auth: { status: "unauthenticated", email: null, plan: null },
  createdAt: "2026-10-23T09:00:00.000Z",
  signIn: null,
};

describe("accountStatus", () => {
  it("says a switched-off account is disabled whatever its login", () => {
    expect(
      accountStatus({
        ...ACCOUNT,
        enabled: false,
        auth: { status: "authenticated", email: "a@b.c", plan: null },
      }),
    ).toEqual({ headline: "Disabled", tone: "disabled" });
  });

  it("names the plan once signed in", () => {
    expect(
      accountStatus({
        ...ACCOUNT,
        auth: { status: "authenticated", email: "a@b.c", plan: "Claude Pro" },
      }),
    ).toEqual({ headline: "Authenticated · Claude Pro", tone: "ready" });
  });

  it("flags an account that has never signed in", () => {
    expect(accountStatus(ACCOUNT)).toEqual({ headline: "Not authenticated", tone: "warning" });
  });

  it("flags an expired login as an error, since turns on it will fail", () => {
    expect(
      accountStatus({ ...ACCOUNT, auth: { status: "expired", email: null, plan: null } }),
    ).toEqual({ headline: "Session expired", tone: "error" });
  });

  it("says a sign-in is under way rather than that it is signed out", () => {
    expect(
      accountStatus({
        ...ACCOUNT,
        signIn: { flowId: "f", phase: "waiting", interaction: null, message: null },
      }),
    ).toEqual({ headline: "Signing in…", tone: "neutral" });
  });
});

describe("isSigningIn", () => {
  it("is true only while an attempt can still change", () => {
    const flow = { flowId: "f", interaction: null, message: null };
    expect(isSigningIn({ ...flow, phase: "verifying" })).toBe(true);
    expect(isSigningIn({ ...flow, phase: "failed" })).toBe(false);
    expect(isSigningIn(null)).toBe(false);
  });
});
