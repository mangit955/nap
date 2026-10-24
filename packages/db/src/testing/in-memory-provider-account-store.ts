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
} from "@nap/shared/ports/provider-account-store";
import type {
  ProviderAccount,
  UpdateProviderAccount,
} from "@nap/shared/provider-accounts-protocol";

type Row = ProviderAccount & { userId: string };

export class InMemoryProviderAccountStore implements ProviderAccountStore {
  readonly #rows: Row[] = [];
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
    if (update.enabled !== undefined) row.enabled = update.enabled;
    return toAccount(row);
  }

  async remove(userId: string, id: string): Promise<boolean> {
    const index = this.#rows.findIndex((row) => row.userId === userId && row.id === id);
    if (index === -1) return false;
    this.#rows.splice(index, 1);
    return true;
  }

  #find(userId: string, id: string): Row | undefined {
    return this.#rows.find((row) => row.userId === userId && row.id === id);
  }
}

function toAccount({ userId: _owner, ...account }: Row): ProviderAccount {
  return structuredClone(account);
}
