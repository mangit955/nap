/**
 * A `ProviderSignInRunner` that plays a scripted attempt, for route tests and the authorization
 * fixture. Nothing is started; `start` records a waiting attempt with the step its driver would
 * show, and the test decides how it ends.
 */

import type { ProviderAccount, ProviderSignIn } from "@nap/shared/provider-accounts-protocol";
import type { ProviderSignInRunner } from "./sign-in.ts";

export class ScriptedProviderSignIn implements ProviderSignInRunner {
  readonly available = true;
  readonly signedOut: string[] = [];
  readonly #flows = new Map<string, ProviderSignIn>();
  #sequence = 0;

  async current(_userId: string, account: ProviderAccount): Promise<ProviderSignIn | null> {
    return this.#flows.get(account.id) ?? null;
  }

  async start(_userId: string, account: ProviderAccount): Promise<ProviderSignIn> {
    this.#sequence += 1;
    const flow: ProviderSignIn = {
      flowId: `flow-${this.#sequence}`,
      phase: "waiting",
      interaction:
        account.driver === "claude"
          ? { type: "terminal", output: "$ claude auth login\n" }
          : { type: "browser", url: "https://auth.openai.com/oauth/authorize" },
      message: null,
    };
    this.#flows.set(account.id, flow);
    return flow;
  }

  async cancel(_userId: string, account: ProviderAccount): Promise<void> {
    const flow = this.#flows.get(account.id);
    if (flow !== undefined)
      this.#flows.set(account.id, { ...flow, phase: "cancelled", interaction: null });
  }

  async signOut(_userId: string, account: ProviderAccount): Promise<void> {
    this.signedOut.push(account.id);
  }
}
