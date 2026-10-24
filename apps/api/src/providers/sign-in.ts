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
import type { ProviderAccount, ProviderSignIn } from "@nap/shared/provider-accounts-protocol";

export type ProviderSignInSession = Pick<ProviderSignInOwner, "userId" | "authSessionId">;

export interface ProviderSignInRunner {
  /** False when this deployment has nowhere to run a provider's agent. */
  readonly available: boolean;

  /** Only this Nap session's attempt. Other sessions must never receive its interaction. */
  current(session: ProviderSignInSession, account: ProviderAccount): Promise<ProviderSignIn | null>;

  /** Starts an attempt, replacing any still running. Only called when `available`. */
  start(session: ProviderSignInSession, account: ProviderAccount): Promise<ProviderSignIn>;

  /** Stops this session's running attempt. Silent when there is none. */
  cancel(session: ProviderSignInSession, account: ProviderAccount): Promise<void>;

  /** Logs the provider's agent out, so the account must sign in again before its next turn. */
  signOut(userId: string, account: ProviderAccount): Promise<void>;
}

/**
 * The runner for a deployment with no provider runtime: nothing is running, and nothing can be
 * started. The page reads `available` and says so instead of offering a button that fails.
 */
export const UNAVAILABLE_SIGN_IN: ProviderSignInRunner = {
  available: false,
  current: async () => null,
  start: async () => {
    throw new Error("start was called on a deployment that cannot sign in");
  },
  cancel: async () => {},
  signOut: async () => {},
};
