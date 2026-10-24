/**
 * What any `ProviderAccountStore` must do, written once and run against both the fake and
 * Postgres.
 *
 * One suite rather than two copies because route tests trust the fake to behave like the table.
 * If the two disagreed about ownership, a route test could pass against the fake while the real
 * store handed one person's account to another.
 */

import type { ProviderAccountStore } from "@nap/shared/ports/provider-account-store";
import { describe, expect, it } from "vitest";

export type StoreHarness = {
  store: ProviderAccountStore;
  /** A user the store will accept rows for. Postgres needs a real `users` row. */
  user(): Promise<string>;
};

const MISSING = "00000000-0000-4000-8000-0000000000aa";

export function providerAccountStoreContract(name: string, harness: () => StoreHarness): void {
  describe(`${name} as a ProviderAccountStore`, () => {
    it("creates an account switched on and signed out", async () => {
      const { store, user } = harness();
      const owner = await user();

      const account = await store.create({ userId: owner, driver: "claude", label: "Work" });

      expect(account).toMatchObject({
        driver: "claude",
        label: "Work",
        enabled: true,
        auth: { status: "unauthenticated", email: null, plan: null },
      });
      await expect(store.get(owner, account.id)).resolves.toEqual(account);
    });

    it("lists one owner's accounts oldest first, and nobody else's", async () => {
      const { store, user } = harness();
      const owner = await user();
      const stranger = await user();

      const first = await store.create({ userId: owner, driver: "codex", label: null });
      const second = await store.create({ userId: owner, driver: "claude", label: null });
      await store.create({ userId: stranger, driver: "claude", label: null });

      const listed = await store.list(owner);
      expect(listed.map((account) => account.id)).toEqual([first.id, second.id]);
    });

    it("treats another owner's account as missing everywhere", async () => {
      const { store, user } = harness();
      const owner = await user();
      const stranger = await user();
      const account = await store.create({ userId: owner, driver: "codex", label: null });

      await expect(store.get(stranger, account.id)).resolves.toBeNull();
      await expect(store.update(stranger, account.id, { enabled: false })).resolves.toBeNull();
      await expect(store.remove(stranger, account.id)).resolves.toBe(false);
      await expect(store.get(owner, account.id)).resolves.toMatchObject({ enabled: true });
    });

    it("updates only the fields it was given", async () => {
      const { store, user } = harness();
      const owner = await user();
      const account = await store.create({ userId: owner, driver: "codex", label: "Personal" });

      const disabled = await store.update(owner, account.id, { enabled: false });
      expect(disabled).toMatchObject({ enabled: false, label: "Personal" });

      const renamed = await store.update(owner, account.id, { label: null });
      expect(renamed).toMatchObject({ enabled: false, label: null });
    });

    it("removes an account once", async () => {
      const { store, user } = harness();
      const owner = await user();
      const account = await store.create({ userId: owner, driver: "claude", label: null });

      await expect(store.remove(owner, account.id)).resolves.toBe(true);
      await expect(store.remove(owner, account.id)).resolves.toBe(false);
      await expect(store.get(owner, account.id)).resolves.toBeNull();
    });

    it("answers null for an id nobody has", async () => {
      const { store, user } = harness();
      const owner = await user();

      await expect(store.get(owner, MISSING)).resolves.toBeNull();
      await expect(store.update(owner, MISSING, { enabled: true })).resolves.toBeNull();
    });

    it("stores sealed authorization separately from public account metadata", async () => {
      const { store, user } = harness();
      const owner = await user();
      const account = await store.create({ userId: owner, driver: "claude", label: null });
      await expect(store.authorization(owner, account.id)).resolves.toEqual({
        kind: "disconnected",
        generation: 0,
        version: 0,
      });
      const result = await store.completeSignIn(owner, account.id, {
        generation: 0,
        credentials: { ciphertext: "sealed-private-credentials", iv: "private-iv" },
        identity: { email: "work@example.com", plan: null },
      });
      expect(result).toMatchObject({
        kind: "updated",
        authorization: { kind: "connected", generation: 1, version: 1 },
      });
      expect(JSON.stringify(await store.get(owner, account.id))).not.toContain(
        "sealed-private-credentials",
      );
      expect(JSON.stringify(await store.list(owner))).not.toContain("private-iv");
      await expect(store.get(owner, account.id)).resolves.toMatchObject({
        auth: { status: "authenticated", email: "work@example.com", plan: null },
      });
    });

    it("rejects another owner's private authorization operations", async () => {
      const { store, user } = harness();
      const owner = await user();
      const stranger = await user();
      const account = await store.create({ userId: owner, driver: "claude", label: null });
      await expect(store.authorization(stranger, account.id)).resolves.toBeNull();
      await expect(
        store.completeSignIn(stranger, account.id, {
          generation: 0,
          credentials: { ciphertext: "sealed", iv: "iv" },
          identity: { email: null, plan: null },
        }),
      ).resolves.toEqual({ kind: "missing" });
      await expect(store.revokeAuthorization(stranger, account.id)).resolves.toBeNull();
      await expect(store.authorization(owner, account.id)).resolves.toMatchObject({
        generation: 0,
      });
    });

    it("fences login completion after logout and rejects replayed completion", async () => {
      const { store, user } = harness();
      const owner = await user();
      const account = await store.create({ userId: owner, driver: "claude", label: null });
      const signIn = {
        generation: 0,
        credentials: { ciphertext: "sealed", iv: "iv" },
        identity: { email: null, plan: null },
      };
      await expect(store.revokeAuthorization(owner, account.id)).resolves.toEqual({
        kind: "disconnected",
        generation: 1,
        version: 1,
      });
      await expect(store.completeSignIn(owner, account.id, signIn)).resolves.toEqual({
        kind: "stale",
      });
      await expect(
        store.completeSignIn(owner, account.id, { ...signIn, generation: 1 }),
      ).resolves.toMatchObject({ kind: "updated" });
      await expect(
        store.completeSignIn(owner, account.id, { ...signIn, generation: 1 }),
      ).resolves.toEqual({ kind: "stale" });
    });

    it("accepts one concurrent credential refresh and never overwrites a newer login", async () => {
      const { store, user } = harness();
      const owner = await user();
      const account = await store.create({ userId: owner, driver: "codex", label: null });
      const credentials = { ciphertext: "sealed", iv: "iv" };
      await store.completeSignIn(owner, account.id, {
        generation: 0,
        credentials,
        identity: { email: null, plan: null },
      });
      const results = await Promise.all(
        ["one", "two"].map((ciphertext) =>
          store.replaceCredentials(owner, account.id, {
            generation: 1,
            version: 1,
            credentials: { ciphertext, iv: "iv" },
          }),
        ),
      );
      expect(results.map((result) => result.kind).sort()).toEqual(["stale", "updated"]);
      await expect(store.authorization(owner, account.id)).resolves.toMatchObject({
        kind: "connected",
        generation: 1,
        version: 2,
      });
      await store.revokeAuthorization(owner, account.id);
      await expect(
        store.replaceCredentials(owner, account.id, { generation: 1, version: 2, credentials }),
      ).resolves.toEqual({ kind: "stale" });
    });

    it("disabling an account atomically revokes its generation and credentials", async () => {
      const { store, user } = harness();
      const owner = await user();
      const account = await store.create({ userId: owner, driver: "claude", label: null });
      const signIn = {
        generation: 0,
        credentials: { ciphertext: "sealed", iv: "iv" },
        identity: { email: "a@example.com", plan: "reported plan" },
      };
      await store.completeSignIn(owner, account.id, signIn);
      await store.update(owner, account.id, { enabled: false });
      await expect(store.authorization(owner, account.id)).resolves.toEqual({
        kind: "disconnected",
        generation: 2,
        version: 2,
      });
      await expect(
        store.completeSignIn(owner, account.id, { ...signIn, generation: 2 }),
      ).resolves.toEqual({ kind: "disabled" });
      await store.update(owner, account.id, { enabled: true });
      await expect(store.authorization(owner, account.id)).resolves.toEqual({
        kind: "disconnected",
        generation: 2,
        version: 2,
      });
      await expect(store.get(owner, account.id)).resolves.toMatchObject({
        auth: { status: "unauthenticated", email: null, plan: null },
      });
    });

    it("deleting an account removes its private authorization", async () => {
      const { store, user } = harness();
      const owner = await user();
      const account = await store.create({ userId: owner, driver: "claude", label: null });
      await store.completeSignIn(owner, account.id, {
        generation: 0,
        credentials: { ciphertext: "sealed", iv: "iv" },
        identity: { email: null, plan: null },
      });
      await store.remove(owner, account.id);
      await expect(store.authorization(owner, account.id)).resolves.toBeNull();
    });
  });
}
