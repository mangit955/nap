import { randomUUID } from "node:crypto";
import { InMemoryProviderAccountStore } from "./in-memory-provider-account-store.ts";
import { providerAccountStoreContract } from "./provider-account-store-contract.ts";

providerAccountStoreContract("InMemoryProviderAccountStore", () => ({
  store: new InMemoryProviderAccountStore(),
  user: async () => randomUUID(),
}));
