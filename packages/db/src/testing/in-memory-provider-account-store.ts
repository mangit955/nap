/**
 * A `ProviderAccountStore` holding rows in a map, for route tests that should not start a
 * database to say "this person has a Claude account".
 *
 * Accounts are handed back as copies, and `createdAt` advances by a counter rather than by the
 * clock, so "oldest first" is deterministic even for two accounts made in the same millisecond.
 */

import { randomUUID } from "node:crypto";
import type {
  NewProviderAccount,
  ProviderAccountStore,
  ProviderAuthorization,
  ProviderAuthorizationWrite,
  ProviderCredentialRefresh,
  ProviderSignInCommit,
} from "@nap/shared/ports/provider-account-store";
import type {
  ProviderAccount,
  UpdateProviderAccount,
} from "@nap/shared/provider-accounts-protocol";

type Row = ProviderAccount & { userId: string };

export class InMemoryProviderAccountStore implements ProviderAccountStore {
  readonly #rows: Row[] = [];
  readonly #authorizations = new Map<string, ProviderAuthorization>();
  #sequence = 0;

  /** Seeds accounts as given, ids included, for fixtures that must name one. */
  constructor(seed: readonly Row[] = []) {
    for (const row of seed) this.#rows.push(structuredClone(row));
  }

  async list(userId: string): Promise<ProviderAccount[]> {
    return this.#rows
      .filter((row) => row.userId === userId)
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id))
      .map(toAccount);
  }

  async get(userId: string, id: string): Promise<ProviderAccount | null> {
    const row = this.#find(userId, id);
    return row === undefined ? null : toAccount(row);
  }

  async create(account: NewProviderAccount): Promise<ProviderAccount> {
    this.#sequence += 1;
    const row: Row = {
      id: randomUUID(),
      userId: account.userId,
      driver: account.driver,
      label: account.label,
      enabled: true,
      auth: { status: "unauthenticated", email: null, plan: null },
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, this.#sequence)).toISOString(),
    };
    this.#rows.push(row);
    return toAccount(row);
  }

  async update(
    userId: string,
    id: string,
    update: UpdateProviderAccount,
  ): Promise<ProviderAccount | null> {
    const row = this.#find(userId, id);
    if (row === undefined) return null;
    if (update.label !== undefined) row.label = update.label;
    if (update.enabled === false && row.enabled) {
      row.enabled = false;
      await this.revokeAuthorization(userId, id);
    }
    if (update.enabled !== undefined) row.enabled = update.enabled;
    return toAccount(row);
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const index = this.#rows.findIndex((row) => row.userId === userId && row.id === id);
    if (index === -1) return false;
    this.#rows.splice(index, 1);
    this.#authorizations.delete(id);
    return true;
  }

  async authorization(userId: string, id: string): Promise<ProviderAuthorization | null> {
    if (!this.#find(userId, id)) return null;
    return structuredClone(
      this.#authorizations.get(id) ?? { kind: "disconnected", generation: 0, version: 0 },
    );
  }

  async completeSignIn(
    userId: string,
    id: string,
    commit: ProviderSignInCommit,
  ): Promise<ProviderAuthorizationWrite> {
    const row = this.#find(userId, id);
    if (!row) return { kind: "missing" };
    if (!row.enabled) return { kind: "disabled" };
    const current = this.#authorizations.get(id) ?? {
      kind: "disconnected",
      generation: 0,
      version: 0,
    };
    if (current.generation !== commit.generation) return { kind: "stale" };
    const authorization: ProviderAuthorization = {
      kind: "connected",
      generation: current.generation + 1,
      version: current.version + 1,
      credentials: structuredClone(commit.credentials),
    };
    this.#authorizations.set(id, authorization);
    row.auth = { status: "authenticated", ...commit.identity };
    return { kind: "updated", authorization: structuredClone(authorization) };
  }

  async replaceCredentials(
    userId: string,
    id: string,
    refresh: ProviderCredentialRefresh,
  ): Promise<ProviderAuthorizationWrite> {
    const row = this.#find(userId, id);
    if (!row) return { kind: "missing" };
    if (!row.enabled) return { kind: "disabled" };
    const current = this.#authorizations.get(id);
    if (
      current?.kind !== "connected" ||
      current.generation !== refresh.generation ||
      current.version !== refresh.version
    )
      return { kind: "stale" };
    const authorization: ProviderAuthorization = {
      ...current,
      version: current.version + 1,
      credentials: structuredClone(refresh.credentials),
    };
    this.#authorizations.set(id, authorization);
    return { kind: "updated", authorization: structuredClone(authorization) };
  }

  async revokeAuthorization(userId: string, id: string): Promise<ProviderAuthorization | null> {
    const row = this.#find(userId, id);
    if (!row) return null;
    const current = this.#authorizations.get(id) ?? { generation: 0, version: 0 };
    const authorization: ProviderAuthorization = {
      kind: "disconnected",
      generation: current.generation + 1,
      version: current.version + 1,
    };
    this.#authorizations.set(id, authorization);
    row.auth = { status: "unauthenticated", email: null, plan: null };
    return structuredClone(authorization);
  }

  #find(userId: string, id: string): Row | undefined {
    return this.#rows.find((row) => row.userId === userId && row.id === id);
  }
}

function toAccount({ userId: _owner, ...account }: Row): ProviderAccount {
  return structuredClone(account);
}
