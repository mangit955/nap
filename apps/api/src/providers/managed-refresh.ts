/** Managed OAuth refresh owns a durable claim; native CLI refresh is a different protocol. */
import type { SubscriptionTarget } from "@nap/shared/execution-target";
import type { ProviderAccountStore } from "@nap/shared/ports/provider-account-store";
import {
  PROVIDER_REFRESH_TTL_MS,
  type ProviderRefreshStore,
} from "@nap/shared/ports/provider-refresh-store";
import type { ProviderDriver } from "@nap/shared/provider-accounts-protocol";
import type { Result } from "@nap/shared/result";
import { z } from "zod";
import { withAuthDeadline } from "./auth-deadline.ts";
import type { ProviderSecretBox } from "./secret-box.ts";

/** The installed provider adapter validates replacement tokens and account continuity. */
export interface ManagedRefreshDriver {
  refresh(input: {
    credentials: string;
    signal: AbortSignal;
  }): Promise<Result<string, { reason: "rejected" | "uncertain" }>>;
}
type RefreshResult = Result<
  { generation: number; version: number },
  {
    code:
      | "missing"
      | "disabled"
      | "stale"
      | "busy"
      | "reconnect_required"
      | "disconnected"
      | "unavailable";
  }
>;
type Options = {
  accounts: ProviderAccountStore;
  refreshes: ProviderRefreshStore;
  secrets: ProviderSecretBox;
  drivers: ReadonlyMap<ProviderDriver, ManagedRefreshDriver>;
  requestTimeoutMs?: number;
};
export class ManagedProviderRefresh {
  readonly #options: Options;
  readonly #requestTimeoutMs: number;
  constructor(options: Options) {
    this.#options = { ...options, drivers: new Map(options.drivers) };
    this.#requestTimeoutMs = z
      .int()
      .min(1)
      .max(PROVIDER_REFRESH_TTL_MS - 5_000)
      .parse(options.requestTimeoutMs ?? 20_000);
  }
  async refresh(userId: string, target: SubscriptionTarget): Promise<RefreshResult> {
    const account = await this.#options.accounts.get(userId, target.accountId);
    if (account === null) return { ok: false, error: { code: "missing" } };
    if (!account.enabled) return { ok: false, error: { code: "disabled" } };
    if (account.driver !== target.driver) return { ok: false, error: { code: "stale" } };
    const driver = this.#options.drivers.get(account.driver);
    if (driver === undefined) return { ok: false, error: { code: "unavailable" } };
    const authorization = await this.#options.accounts.authorization(userId, account.id);
    if (authorization === null) return { ok: false, error: { code: "missing" } };
    if (authorization.kind === "refreshing") return { ok: false, error: { code: "busy" } };
    if (authorization.kind !== "connected")
      return { ok: false, error: { code: authorization.kind } };
    if (authorization.generation !== target.generation)
      return { ok: false, error: { code: "stale" } };
    const revision = {
      userId,
      accountId: account.id,
      generation: authorization.generation,
      version: authorization.version,
    };
    const claim = await this.#options.refreshes.claimManagedRefresh(revision);
    if (claim.kind !== "claimed") return { ok: false, error: { code: claim.kind } };
    const finish = { ...revision, claimToken: claim.claimToken };
    const scope = {
      kind: "authorization",
      userId,
      accountId: account.id,
      driver: account.driver,
      generation: authorization.generation,
    } as const;
    try {
      const opened = this.#options.secrets.open(scope, claim.credentials);
      if (!opened.ok) return this.#uncertain(finish);
      const result = await withAuthDeadline({
        expiresAt: claim.expiresAt,
        maxDurationMs: this.#requestTimeoutMs,
        action: (signal) => driver.refresh({ credentials: opened.value, signal }),
      });
      if (!result.ok) return this.#uncertain(finish);
      const credentials = z.string().min(1).max(1_048_576).parse(result.value);
      const written = await this.#options.refreshes.finishManagedRefresh({
        ...finish,
        outcome: { kind: "renewed", credentials: this.#options.secrets.seal(scope, credentials) },
      });
      if (written.kind !== "updated") return { ok: false, error: { code: written.kind } };
      return written.authorization.kind === "connected"
        ? {
            ok: true,
            value: {
              generation: written.authorization.generation,
              version: written.authorization.version,
            },
          }
        : { ok: false, error: { code: "reconnect_required" } };
    } catch {
      // Do not retry a provider exchange whose receipt may have been lost after rotation.
      return this.#uncertain(finish);
    }
  }
  async #uncertain(
    input: Omit<Parameters<ProviderRefreshStore["finishManagedRefresh"]>[0], "outcome">,
  ): Promise<RefreshResult> {
    try {
      const result = await this.#options.refreshes.finishManagedRefresh({
        ...input,
        outcome: { kind: "uncertain" },
      });
      return {
        ok: false,
        error: { code: result.kind === "updated" ? "reconnect_required" : result.kind },
      };
    } catch {
      // The durable claim still blocks another owner. Its expiry also requires reconnect.
      return { ok: false, error: { code: "unavailable" } };
    }
  }
}
