/**
 * Running a provider's own sign-in for one of somebody's provider accounts.
 *
 * A port because signing in means starting the provider's agent somewhere: `claude auth login`
 * in a terminal for Claude Code, ChatGPT's consent page for Codex. Where that agent runs, and how
 * its login outlives a sandbox, is the runtime's business. The routes only start, read, cancel
 * and sign out.
 *
 * **No implementation here ever sees a credential.** The provider's agent completes the login and
 * keeps what it stores. What comes back through this port is the step the person has to take next
 * and, once it is over, who signed in.
 */

import type { ProviderAccount, ProviderSignIn } from "@nap/shared/provider-accounts-protocol";

export interface ProviderSignInRunner {
  /** False when this deployment has nowhere to run a provider's agent. */
  readonly available: boolean;

  /** The attempt running for this account, or the one that just finished. Null if none. */
  current(userId: string, account: ProviderAccount): Promise<ProviderSignIn | null>;

  /** Starts an attempt, replacing any still running. Only called when `available`. */
  start(userId: string, account: ProviderAccount): Promise<ProviderSignIn>;

  /** Stops the running attempt. Silent when there is none. */
  cancel(userId: string, account: ProviderAccount): Promise<void>;

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
