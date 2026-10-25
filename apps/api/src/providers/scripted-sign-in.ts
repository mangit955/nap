/**
 * A `ProviderSignInRunner` that plays a scripted attempt, for route tests and the authorization
 * fixture. Nothing is started; `start` records a waiting attempt with the step its driver would
 * show, and the test decides how it ends.
 */

import type {
  ProviderAccount,
  ProviderDriver,
  ProviderSignIn,
} from "@nap/shared/provider-accounts-protocol";
import type { SubmitProviderCode } from "@nap/shared/provider-auth-input-protocol";
import type {
  ProviderSignInResult,
  ProviderSignInRunner,
  ProviderSignInSession,
} from "./sign-in.ts";

export class ScriptedProviderSignIn implements ProviderSignInRunner {
  constructor(readonly drivers: readonly ProviderDriver[] = ["claude", "codex"]) {}
  readonly signedOut: string[] = [];
  readonly #flows = new Map<string, { userId: string; accountId: string; flow: ProviderSignIn }>();

  #key(session: ProviderSignInSession, account: ProviderAccount): string {
    return JSON.stringify([session.userId, session.authSessionId, account.id]);
  }

  #cancelAccount(userId: string, account: ProviderAccount): void {
    for (const entry of this.#flows.values()) {
      if (
        entry.userId === userId &&
        entry.accountId === account.id &&
        ["starting", "waiting", "verifying"].includes(entry.flow.phase)
      )
        entry.flow = { ...entry.flow, phase: "cancelled", interaction: null };
    }
  }

  async current(
    session: ProviderSignInSession,
    account: ProviderAccount,
  ): Promise<ProviderSignIn | null> {
    const entry = this.#flows.get(this.#key(session, account));
    return entry === undefined ? null : structuredClone(entry.flow);
  }

  async start(
    session: ProviderSignInSession,
    account: ProviderAccount,
  ): Promise<ProviderSignInResult> {
    this.#cancelAccount(session.userId, account);
    const flow: ProviderSignIn = {
      flowId: crypto.randomUUID(),
      phase: "waiting",
      interaction:
        account.driver === "claude"
          ? { type: "terminal", output: "$ claude auth login\n", input: "code" }
          : { type: "browser", url: "https://auth.openai.com/oauth/authorize" },
      message: null,
    };
    this.#flows.set(this.#key(session, account), {
      userId: session.userId,
      accountId: account.id,
      flow,
    });
    return { ok: true, value: structuredClone(flow) };
  }

  async complete(): Promise<ProviderSignInResult> {
    return { ok: false, error: { code: "unavailable" } };
  }

  async submitCode(
    session: ProviderSignInSession,
    account: ProviderAccount,
    input: SubmitProviderCode,
  ): Promise<ProviderSignInResult> {
    const entry = this.#flows.get(this.#key(session, account));
    if (
      entry?.flow.flowId !== input.flowId ||
      entry.flow.phase !== "waiting" ||
      entry.flow.interaction?.type !== "terminal" ||
      entry.flow.interaction.input !== "code"
    )
      return { ok: false, error: { code: "stale" } };
    // Accepting input does not prove authentication. Only a driver can verify the account.
    entry.flow = { ...entry.flow, phase: "verifying", interaction: null };
    return { ok: true, value: structuredClone(entry.flow) };
  }

  async cancel(session: ProviderSignInSession, account: ProviderAccount): Promise<void> {
    const entry = this.#flows.get(this.#key(session, account));
    if (entry !== undefined && ["starting", "waiting", "verifying"].includes(entry.flow.phase))
      entry.flow = { ...entry.flow, phase: "cancelled", interaction: null };
  }

  async signOut(userId: string, account: ProviderAccount): Promise<void> {
    this.#cancelAccount(userId, account);
    this.signedOut.push(account.id);
  }
}
