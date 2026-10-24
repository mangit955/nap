/** Durable native CLI login coordination. Configuring a driver requires its hosted release gates. */
import { randomBytes } from "node:crypto";
import type { ProviderAccountStore } from "@nap/shared/ports/provider-account-store";
import type { ProviderSignInProcessStore } from "@nap/shared/ports/provider-sign-in-process-store";
import {
  ProviderSignInChallengeSchema,
  type ProviderSignInOwner,
  type ProviderSignInStore,
} from "@nap/shared/ports/provider-sign-in-store";
import type { ProcessExit } from "@nap/shared/ports/sandbox-process";
import {
  type ProviderAccount,
  type ProviderDriver,
  type ProviderSignIn,
  ProviderSignInSchema,
} from "@nap/shared/provider-accounts-protocol";
import type { SubmitProviderCode } from "@nap/shared/provider-auth-input-protocol";
import type { Result } from "@nap/shared/result";
import { z } from "zod";
import { withAuthDeadline } from "./auth-deadline.ts";
import type { ProviderSecretBox } from "./secret-box.ts";
import type {
  ProviderSignInResult,
  ProviderSignInRunner,
  ProviderSignInSession,
} from "./sign-in.ts";

const envelope = z.strictObject({ driverState: z.string().max(524_288) });
const status = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("waiting"),
    interaction: z.strictObject({
      type: z.literal("terminal"),
      output: z.string().max(65_536),
      input: z.literal("code").optional(),
    }),
  }),
  z.strictObject({ kind: z.literal("ready") }),
  z.strictObject({ kind: z.literal("failed") }),
]);
const grant = z.object({
  credentials: z.string().min(1).max(1_048_576),
  identity: z.strictObject({
    email: z.string().max(320).nullable(),
    plan: z.string().max(320).nullable(),
  }),
  proofs: z.array(z.object({ containment: z.literal("cgroup") })).min(1),
});
type Flow = { owner: ProviderSignInOwner; flowId: string };
export type TerminalAuthContext = Flow & {
  signal: AbortSignal;
  read(): Promise<string>;
  /** Merge against the latest decrypted state; returning it unchanged acknowledges a replay. */
  checkpoint(update: (current: string) => string): Promise<void>;
};
export interface TerminalAuthDriver {
  /** A fresh, isolated home per attempt; never mutate a connected account's credential home. */
  begin(context: TerminalAuthContext): Promise<void>;
  /** Recover output only. Never replay input or start a replacement login. */
  poll(context: TerminalAuthContext): Promise<void>;
  status(state: string): z.infer<typeof status>;
  /** Own CLI authentication, status verification and durable private-home export; no model call. */
  verify(context: TerminalAuthContext & { code: string | null }): Promise<
    Result<
      {
        credentials: string;
        identity: { email: string | null; plan: string | null };
        proofs: ProcessExit[];
      },
      { reason: "provider_unavailable" | "verification_failed" }
    >
  >;
  /** Stop the temporary runtime; never delete an already published private grant. */
  cancel(context: TerminalAuthContext): Promise<void>;
}
export class TerminalProviderSignIn implements ProviderSignInRunner {
  readonly drivers: readonly ProviderDriver[];
  readonly #options;
  constructor(options: {
    accounts: ProviderAccountStore;
    attempts: ProviderSignInStore;
    processes: ProviderSignInProcessStore;
    secrets: ProviderSecretBox;
    drivers: ReadonlyMap<ProviderDriver, TerminalAuthDriver>;
  }) {
    this.#options = { ...options, drivers: new Map(options.drivers) };
    this.drivers = [...this.#options.drivers.keys()];
  }
  async #driver(session: ProviderSignInSession, account: ProviderAccount) {
    const current = await this.#options.accounts.get(session.userId, account.id);
    if (current === null) return { ok: false as const, error: { code: "missing" as const } };
    if (!current.enabled) return { ok: false as const, error: { code: "disabled" as const } };
    const driver = this.#options.drivers.get(current.driver);
    return driver === undefined
      ? { ok: false as const, error: { code: "unavailable" as const } }
      : { ok: true as const, value: { account: current, driver } };
  }
  async #snapshot(flow: Flow) {
    const current = await this.#options.processes.inspectSignInProcess(flow);
    if (current.kind !== "ready") throw new Error("Native sign-in state is unavailable.");
    const scope = { kind: "attempt" as const, ...flow.owner, challengeHash: current.challengeHash };
    const opened = this.#options.secrets.open(scope, current.state);
    if (!opened.ok) throw new Error("Native sign-in state could not be opened.");
    return { ...current, scope, driverState: envelope.parse(JSON.parse(opened.value)).driverState };
  }
  #context(flow: Flow, signal: AbortSignal): TerminalAuthContext {
    return {
      ...flow,
      signal,
      read: async () => (await this.#snapshot(flow)).driverState,
      checkpoint: async (update) => {
        for (let attempt = 0; attempt < 16; attempt++) {
          signal.throwIfAborted();
          const current = await this.#snapshot(flow);
          const next = envelope.parse({ driverState: update(current.driverState) });
          if (next.driverState === current.driverState) return;
          const saved = await this.#options.processes.checkpointSignInProcess({
            ...flow,
            version: current.version,
            state: this.#options.secrets.seal(current.scope, JSON.stringify(next)),
          });
          if (saved.kind === "updated") return;
          if (saved.kind !== "conflict")
            throw new Error("Native sign-in checkpoint is unavailable.");
        }
        throw new Error("Native sign-in checkpoint contention exceeded its bound.");
      },
    };
  }
  async start(
    session: ProviderSignInSession,
    account: ProviderAccount,
  ): Promise<ProviderSignInResult> {
    const found = await this.#driver(session, account);
    if (!found.ok) return found;
    const owner = { ...session, accountId: account.id };
    const challengeHash = ProviderSignInChallengeSchema.parse(randomBytes(32).toString("hex"));
    const started = await this.#options.attempts.beginSignIn({
      owner,
      challengeHash,
      state: this.#options.secrets.seal(
        { kind: "attempt", ...owner, challengeHash },
        JSON.stringify({ driverState: "" }),
      ),
    });
    if (started.kind !== "updated") return { ok: false, error: { code: started.kind } };
    const flow = { owner, flowId: started.attempt.flowId };
    try {
      await withAuthDeadline({
        expiresAt: started.attempt.expiresAt,
        maxDurationMs: 30_000,
        action: (signal) => found.value.driver.begin(this.#context(flow, signal)),
      });
      for (let attempt = 0; attempt < 16; attempt++) {
        const current = await this.#snapshot(flow);
        const step = status.parse(found.value.driver.status(current.driverState));
        if (step.kind === "failed") return this.#fail(flow, "verification_failed");
        const presented = await this.#options.attempts.presentSignIn({
          ...flow,
          version: current.version,
          state: current.state,
          interaction:
            step.kind === "waiting"
              ? step.interaction
              : { type: "terminal", output: "Verifying the provider account…" },
        });
        if (presented.kind === "updated")
          return step.kind === "ready"
            ? this.#verify(session, account, flow.flowId, null)
            : { ok: true, value: ProviderSignInSchema.parse(presented.attempt) };
        if (presented.kind !== "stale") return { ok: false, error: { code: presented.kind } };
      }
      return this.#fail(flow, "provider_unavailable");
    } catch {
      return this.#fail(flow, "provider_unavailable");
    }
  }
  async current(
    session: ProviderSignInSession,
    account: ProviderAccount,
  ): Promise<ProviderSignIn | null> {
    const owner = { ...session, accountId: account.id };
    const attempt = await this.#options.attempts.currentSignIn(owner);
    if (attempt === null || attempt.phase !== "waiting")
      return attempt === null ? null : ProviderSignInSchema.parse(attempt);
    const found = await this.#driver(session, account);
    if (!found.ok) return null;
    const flow = { owner, flowId: attempt.flowId };
    try {
      await withAuthDeadline({
        expiresAt: attempt.expiresAt,
        maxDurationMs: 3000,
        action: (signal) => found.value.driver.poll(this.#context(flow, signal)),
      });
      const current = await this.#snapshot(flow);
      // Another controller may have consumed the input while this poll was recovering output.
      if (current.phase !== "waiting") {
        const latest = await this.#options.attempts.currentSignIn(owner);
        return latest === null ? null : ProviderSignInSchema.parse(latest);
      }
      const step = status.parse(found.value.driver.status(current.driverState));
      if (step.kind === "waiting")
        return { ...ProviderSignInSchema.parse(attempt), interaction: step.interaction };
      const result =
        step.kind === "ready"
          ? await this.#verify(session, account, flow.flowId, null)
          : await this.#fail(flow, "verification_failed");
      return result.ok ? result.value : null;
    } catch {
      const latest = await this.#options.attempts.currentSignIn(owner);
      return latest === null ? null : ProviderSignInSchema.parse(latest);
    }
  }
  async submitCode(
    session: ProviderSignInSession,
    account: ProviderAccount,
    input: SubmitProviderCode,
  ): Promise<ProviderSignInResult> {
    return this.#verify(session, account, input.flowId, input.code);
  }
  async complete(): Promise<ProviderSignInResult> {
    return { ok: false, error: { code: "unavailable" } };
  }
  async #verify(
    session: ProviderSignInSession,
    account: ProviderAccount,
    flowId: string,
    code: string | null,
  ): Promise<ProviderSignInResult> {
    const found = await this.#driver(session, account);
    if (!found.ok) return found;
    const flow = { owner: { ...session, accountId: account.id }, flowId };
    try {
      const current = await this.#snapshot(flow);
      const step = status.parse(found.value.driver.status(current.driverState));
      if (
        current.phase !== "waiting" ||
        (code === null
          ? step.kind !== "ready"
          : step.kind !== "waiting" || step.interaction.input !== "code")
      )
        return { ok: false, error: { code: "stale" } };
      const claim = await this.#options.attempts.claimSignIn({
        ...flow,
        challengeHash: current.challengeHash,
      });
      if (claim.kind !== "claimed") return { ok: false, error: { code: claim.kind } };
      const attempt = await this.#options.attempts.currentSignIn(flow.owner);
      if (attempt?.flowId !== flowId || attempt.phase !== "verifying")
        return { ok: false, error: { code: "stale" } };
      const verified = await withAuthDeadline({
        expiresAt: attempt.expiresAt,
        maxDurationMs: 30_000,
        action: (signal) => found.value.driver.verify({ ...this.#context(flow, signal), code }),
      });
      if (!verified.ok) return this.#fail(flow, verified.error.reason);
      const validated = grant.safeParse(verified.value);
      if (!validated.success) return this.#fail(flow, "verification_failed");
      const committed = await this.#options.attempts.finishSignIn({
        ...flow,
        outcome: {
          kind: "verified",
          claimToken: claim.claimToken,
          credentials: this.#options.secrets.seal(
            {
              kind: "authorization",
              userId: session.userId,
              accountId: account.id,
              driver: found.value.account.driver,
              generation: claim.generation + 1,
            },
            validated.data.credentials,
          ),
          identity: validated.data.identity,
        },
      });
      return committed.kind === "updated"
        ? { ok: true, value: ProviderSignInSchema.parse(committed.attempt) }
        : { ok: false, error: { code: committed.kind } };
    } catch {
      return this.#fail(flow, "provider_unavailable");
    }
  }
  async #fail(
    flow: Flow,
    reason: "provider_unavailable" | "verification_failed",
  ): Promise<ProviderSignInResult> {
    const cleanup = await this.#cleanup(flow);
    const result = await this.#options.attempts.finishSignIn({
      ...flow,
      outcome: { kind: "failed", reason },
    });
    await cleanup?.();
    return result.kind === "updated"
      ? { ok: true, value: ProviderSignInSchema.parse(result.attempt) }
      : { ok: false, error: { code: result.kind } };
  }
  async #cleanup(flow: Flow): Promise<(() => Promise<void>) | null> {
    try {
      const account = await this.#options.accounts.get(flow.owner.userId, flow.owner.accountId);
      const driver = account === null ? undefined : this.#options.drivers.get(account.driver);
      if (driver === undefined) return null;
      const captured = (await this.#snapshot(flow)).driverState;
      return async () => {
        await withAuthDeadline({
          expiresAt: new Date(Date.now() + 3000).toISOString(),
          maxDurationMs: 3000,
          action: (signal) =>
            driver.cancel({
              ...flow,
              signal,
              read: async () => captured,
              checkpoint: async () => {
                throw new Error("Sign-in was stopped.");
              },
            }),
        }).catch(() => {});
      };
    } catch {
      return null;
    }
  }
  async cancel(session: ProviderSignInSession, account: ProviderAccount): Promise<void> {
    const owner = { ...session, accountId: account.id };
    const attempt = await this.#options.attempts.currentSignIn(owner);
    if (attempt === null) return;
    const flow = { owner, flowId: attempt.flowId };
    const cleanup = await this.#cleanup(flow);
    await this.#options.attempts.cancelSignIn(flow);
    await cleanup?.();
  }
  async signOut(): Promise<void> {
    // Authorization is revoked by the route; this runner never exports a provider token.
  }
}
