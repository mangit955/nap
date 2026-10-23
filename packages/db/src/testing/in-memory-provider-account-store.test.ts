import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { InMemoryProviderAccountStore } from "./in-memory-provider-account-store.ts";
import { providerAccountStoreContract } from "./provider-account-store-contract.ts";

providerAccountStoreContract("InMemoryProviderAccountStore", () => ({
  store: new InMemoryProviderAccountStore(),
  user: async () => randomUUID(),
}));

it("lists seeded accounts by creation time then id, regardless of insertion order", async () => {
  const owner = randomUUID();
  const row = {
    userId: owner,
    driver: "claude" as const,
    label: null,
    enabled: true,
    auth: { status: "unauthenticated" as const, email: null, plan: null },
    createdAt: "2026-10-23T09:00:00.000Z",
  };
  const early = "00000000-0000-4000-8000-000000000001";
  const late = "00000000-0000-4000-8000-000000000002";
  const store = new InMemoryProviderAccountStore([
    { ...row, id: late },
    { ...row, id: early },
    { ...row, id: randomUUID(), userId: randomUUID() },
  ]);
  const created = await store.create({ userId: owner, driver: "claude", label: null });
  expect((await store.list(owner)).map((account) => account.id)).toEqual([created.id, early, late]);
});
