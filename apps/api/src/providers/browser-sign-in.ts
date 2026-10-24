/** Durable browser handoff. Provider adapters own their approved OAuth and identity checks. */
import { createHash, randomBytes } from "node:crypto";
import type { ProviderAccountStore } from "@nap/shared/ports/provider-account-store";
import {
  type ProviderSignInAttemptWrite,
  ProviderSignInChallengeSchema,
  type ProviderSignInOwner,
  type ProviderSignInStore,
} from "@nap/shared/ports/provider-sign-in-store";
import {
  type ProviderAccount,
  type ProviderDriver,
  type ProviderSignIn,
  ProviderSignInInteractionSchema,
  ProviderSignInSchema,
} from "@nap/shared/provider-accounts-protocol";
import type { Result } from "@nap/shared/result";
import { z } from "zod";
import type { ProviderSecretBox, ProviderSecretScope } from "./secret-box.ts";
import type {
  ProviderSignInResult,
  ProviderSignInRunner,
  ProviderSignInSession,
} from "./sign-in.ts";

type AuthFailure = { reason: "provider_unavailable" | "verification_failed" };
/** Configure an adapter only after its hosted authentication route has been approved. */
export interface BrowserAuthDriver {
  begin(input: { challenge: string; signal: AbortSignal }): Promise<
    Result<
      {
        url: string;
        state: string;
      },
      AuthFailure
    >
  >;
  /** Validate the exact redirect URI and unambiguous response before extracting its state. */
  challenge(redirect: string): string | null;
  /** Includes issuer, audience, nonce, PKCE, scope and identity validation where required. */
  verify(input: {
    redirect: string;
    challenge: string;
    state: string;
    signal: AbortSignal;
  }): Promise<
    Result<
      {
        credentials: string;
        identity: { email: string | null; plan: string | null };
      },
      AuthFailure
    >
  >;
}
export type BrowserSignInOptions = {
  accounts: ProviderAccountStore;
  attempts: ProviderSignInStore;
  secrets: ProviderSecretBox;
  drivers: ReadonlyMap<ProviderDriver, BrowserAuthDriver>;
};
const privateState = z.strictObject({
  challenge: z.string().regex(/^[a-f0-9]{64}$/),
  driverState: z.string().max(65_536),
});
const grantSchema = z.strictObject({
  credentials: z.string().min(1).max(1_048_576),
  identity: z.strictObject({
    email: z.string().max(320).nullable(),
    plan: z.string().max(320).nullable(),
  }),
});
const challengeHash = (challenge: string) =>
  ProviderSignInChallengeSchema.parse(createHash("sha256").update(challenge).digest("hex"));
const publicResult = (result: ProviderSignInAttemptWrite): ProviderSignInResult =>
  result.kind === "updated"
    ? { ok: true, value: ProviderSignInSchema.parse(result.attempt) }
    : { ok: false, error: { code: result.kind } };

async function bounded<T>(
  expiresAt: string,
  action: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const signal = AbortSignal.timeout(
    Math.max(1, Math.min(30_000, Date.parse(expiresAt) - Date.now())),
  );
  let aborted = () => {};
  const timeout = new Promise<never>((_resolve, reject) => {
    aborted = () => reject(new Error("Provider authentication deadline reached"));
    signal.addEventListener("abort", aborted, { once: true });
  });
  try {
    return await Promise.race([action(signal), timeout]);
  } finally {
    signal.removeEventListener("abort", aborted);
  }
}

export class BrowserProviderSignIn implements ProviderSignInRunner {
  readonly drivers: readonly ProviderDriver[];
  readonly #options: BrowserSignInOptions;
  constructor(options: BrowserSignInOptions) {
    // Snapshot configuration so a caller cannot enable another adapter during a running flow.
    this.#options = { ...options, drivers: new Map(options.drivers) };
    this.drivers = [...this.#options.drivers.keys()];
  }

  async current(
    session: ProviderSignInSession,
    account: ProviderAccount,
  ): Promise<ProviderSignIn | null> {
    const attempt = await this.#options.attempts.currentSignIn({
      ...session,
      accountId: account.id,
    });
    return attempt === null ? null : ProviderSignInSchema.parse(attempt);
  }

  async start(
    session: ProviderSignInSession,
    account: ProviderAccount,
  ): Promise<ProviderSignInResult> {
    const found = await this.#driver(session, account);
    if (!found.ok) return found;
    const owner = { ...session, accountId: account.id };
    const challenge = randomBytes(32).toString("hex");
    const scope = this.#scope(owner, challenge);
    const started = await this.#options.attempts.beginSignIn({
      owner,
      challengeHash: scope.challengeHash,
      state: this.#options.secrets.seal(scope, JSON.stringify({ challenge, driverState: "" })),
    });
    if (started.kind !== "updated") return publicResult(started);
    const flow = { owner, flowId: started.attempt.flowId };
    try {
      const result = await bounded(started.attempt.expiresAt, (signal) =>
        found.value.driver.begin({ challenge, signal }),
      );
      if (!result.ok) return this.#fail(flow, result.error.reason);
      const state = privateState.parse({ challenge, driverState: result.value.state });
      const interaction = ProviderSignInInteractionSchema.parse({
        type: "browser",
        url: result.value.url,
      });
      return publicResult(
        await this.#options.attempts.presentSignIn({
          ...flow,
          interaction,
          state: this.#options.secrets.seal(scope, JSON.stringify(state)),
        }),
      );
    } catch {
      return this.#fail(flow, "provider_unavailable");
    }
  }

  async complete(
    session: ProviderSignInSession,
    account: ProviderAccount,
    input: { flowId: string; redirect: string },
  ): Promise<ProviderSignInResult> {
    const found = await this.#driver(session, account);
    if (!found.ok) return found;
    let challenge: string | null;
    try {
      challenge = found.value.driver.challenge(input.redirect);
    } catch {
      challenge = null;
    }
    if (challenge === null || !/^[a-f0-9]{64}$/.test(challenge))
      return { ok: false, error: { code: "invalid_callback" } };
    const owner = { ...session, accountId: account.id };
    const flow = { owner, flowId: input.flowId };
    const claim = await this.#options.attempts.claimSignIn({
      ...flow,
      challengeHash: challengeHash(challenge),
    });
    if (claim.kind !== "claimed") return { ok: false, error: { code: claim.kind } };
    const opened = this.#options.secrets.open(this.#scope(owner, challenge), claim.state);
    if (!opened.ok) return this.#fail(flow, "verification_failed");
    try {
      const state = privateState.parse(JSON.parse(opened.value));
      if (state.challenge !== challenge) return this.#fail(flow, "verification_failed");
      // Read the original deadline after claiming; exchange never receives a fresh five minutes.
      const attempt = await this.#options.attempts.currentSignIn(owner);
      if (attempt?.flowId !== input.flowId || attempt.phase !== "verifying")
        return { ok: false, error: { code: "stale" } };
      const result = await bounded(attempt.expiresAt, (signal) =>
        found.value.driver.verify({
          redirect: input.redirect,
          challenge,
          state: state.driverState,
          signal,
        }),
      );
      if (!result.ok) return this.#fail(flow, result.error.reason);
      const grant = grantSchema.parse(result.value);
      return publicResult(
        await this.#options.attempts.finishSignIn({
          ...flow,
          outcome: {
            kind: "verified",
            claimToken: claim.claimToken,
            credentials: this.#options.secrets.seal(
              {
                kind: "authorization",
                userId: owner.userId,
                accountId: owner.accountId,
                driver: found.value.account.driver,
                generation: claim.generation + 1,
              },
              grant.credentials,
            ),
            identity: grant.identity,
          },
        }),
      );
    } catch {
      // A lost exchange response is terminal, never an instruction to exchange the code again.
      return this.#fail(flow, "provider_unavailable");
    }
  }

  async cancel(session: ProviderSignInSession, account: ProviderAccount): Promise<void> {
    const owner = { ...session, accountId: account.id };
    const current = await this.#options.attempts.currentSignIn(owner);
    if (current !== null)
      await this.#options.attempts.cancelSignIn({ owner, flowId: current.flowId });
  }

  async signOut(_userId: string, _account: ProviderAccount): Promise<void> {
    // The route revokes stored authorization first. This browser adapter owns no CLI process.
    // Local disconnection does not claim provider-side token revocation.
  }

  #scope(
    owner: ProviderSignInOwner,
    challenge: string,
  ): Extract<ProviderSecretScope, { kind: "attempt" }> {
    return { kind: "attempt", ...owner, challengeHash: challengeHash(challenge) };
  }
  async #driver(
    session: ProviderSignInSession,
    account: ProviderAccount,
  ): Promise<
    Result<
      {
        account: ProviderAccount;
        driver: BrowserAuthDriver;
      },
      { code: "missing" | "disabled" | "unavailable" }
    >
  > {
    const actual = await this.#options.accounts.get(session.userId, account.id);
    if (actual === null) return { ok: false, error: { code: "missing" } };
    if (!actual.enabled) return { ok: false, error: { code: "disabled" } };
    const driver = this.#options.drivers.get(actual.driver);
    return driver === undefined
      ? { ok: false, error: { code: "unavailable" } }
      : { ok: true, value: { account: actual, driver } };
  }
  async #fail(
    flow: { owner: ProviderSignInOwner; flowId: string },
    reason: AuthFailure["reason"],
  ): Promise<ProviderSignInResult> {
    return publicResult(
      await this.#options.attempts.finishSignIn({ ...flow, outcome: { kind: "failed", reason } }),
    );
  }
}
