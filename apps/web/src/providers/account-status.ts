/**
 * The one line under an account's name, after T3 Code's provider summary: what state it is in,
 * and how loudly to say so.
 */

import type { ProviderAccountView, ProviderSignIn } from "@nap/shared/provider-accounts-protocol";

export type StatusTone = "ready" | "warning" | "error" | "neutral" | "disabled";

/** Whether a sign-in attempt can still change, and is therefore worth polling for. */
export function isSigningIn(signIn: ProviderSignIn | null): boolean {
  return (
    signIn !== null &&
    (signIn.phase === "starting" || signIn.phase === "waiting" || signIn.phase === "verifying")
  );
}

export function accountStatus(account: ProviderAccountView): {
  headline: string;
  tone: StatusTone;
} {
  if (!account.enabled) return { headline: "Disabled", tone: "disabled" };
  if (isSigningIn(account.signIn)) return { headline: "Signing in…", tone: "neutral" };
  switch (account.auth.status) {
    case "authenticated":
      return {
        headline: account.auth.plan ? `Authenticated · ${account.auth.plan}` : "Authenticated",
        tone: "ready",
      };
    case "expired":
      return { headline: "Session expired", tone: "error" };
    case "unauthenticated":
      return { headline: "Not authenticated", tone: "warning" };
  }
}

/** The dot beside a status, drawn only where the status needs attention — as T3 does. */
export const TONE_DOT: Record<StatusTone, string | null> = {
  ready: null,
  neutral: null,
  disabled: null,
  warning: "bg-warning",
  error: "bg-danger",
};
