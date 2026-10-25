/**
 * Running a provider's own sign-in for one of somebody's provider accounts.
 *
 * A port because signing in means starting the provider's agent somewhere: `claude auth login`
 * in a terminal for Claude Code, ChatGPT's consent page for Codex. Where that agent runs, and how
 * its login outlives a sandbox, is the runtime's business. The routes only start, read, cancel
 * and sign out.
 *
 * This status port returns no credential. Provider implementations keep private tokens and native
 * state behind the credential store; only the next interaction and verified identity reach a UI.
 */

import type { ProviderSignInOwner } from "@nap/shared/ports/provider-sign-in-store";
import type {
  ProviderAccount,
  ProviderDriver,
  ProviderSignIn,
} from "@nap/shared/provider-accounts-protocol";
import type { SubmitProviderCode } from "@nap/shared/provider-auth-input-protocol";
import type { Result } from "@nap/shared/result";

export type ProviderSignInSession = Pick<ProviderSignInOwner, "userId" | "authSessionId">;

export type ProviderSignInError = {
  code: "missing" | "disabled" | "stale" | "expired" | "unavailable" | "invalid_callback";
};
export type ProviderSignInResult = Result<ProviderSignIn, ProviderSignInError>;

export interface ProviderSignInRunner {
  /** Provider-specific availability; an empty list exposes no sign-in action. */
  readonly drivers: readonly ProviderDriver[];

  /** Only this Nap session's attempt. Other sessions must never receive its interaction. */
  current(session: ProviderSignInSession, account: ProviderAccount): Promise<ProviderSignIn | null>;

  /** Starts an attempt, replacing any still running. Only called for a configured driver. */
  start(session: ProviderSignInSession, account: ProviderAccount): Promise<ProviderSignInResult>;

  /** Browser handoff only. A native terminal must implement a separate input transport. */
  complete(
    session: ProviderSignInSession,
    account: ProviderAccount,
    input: {
      flowId: string;
      redirect: string;
    },
  ): Promise<ProviderSignInResult>;

  /** Single-use input to the provider's own login, never a shell command or an API credential. */
  submitCode(
    session: ProviderSignInSession,
    account: ProviderAccount,
    input: SubmitProviderCode,
  ): Promise<ProviderSignInResult>;

  /** Stops this session's running attempt. Silent when there is none. */
  cancel(session: ProviderSignInSession, account: ProviderAccount): Promise<void>;

  /** Logs the provider's agent out, so the account must sign in again before its next turn. */
  signOut(userId: string, account: ProviderAccount): Promise<void>;
}

/**
 * The runner for a deployment with no provider runtime: nothing is running, and nothing can be
 * started. The page reads `drivers` and says so instead of offering a button that fails.
 */
export const UNAVAILABLE_SIGN_IN: ProviderSignInRunner = {
  drivers: [],
  current: async () => null,
  start: async () => ({ ok: false, error: { code: "unavailable" } }),
  complete: async () => ({ ok: false, error: { code: "unavailable" } }),
  submitCode: async () => ({ ok: false, error: { code: "unavailable" } }),
  cancel: async () => {},
  signOut: async () => {},
};
