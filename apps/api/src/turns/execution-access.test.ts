import { FAKE_OWNER } from "@nap/db/testing/in-memory-project-store";
import { InMemoryProviderAccountStore } from "@nap/db/testing/in-memory-provider-account-store";
import { expect, it, vi } from "vitest";
import { SubscriptionAccess } from "../providers/subscription-access.ts";
import { ExecutionAccess } from "./execution-access.ts";

const ACCOUNT = "00000000-0000-4000-8000-000000000099";
function fixture() {
  const accounts = new InMemoryProviderAccountStore([
    {
      id: ACCOUNT,
      userId: FAKE_OWNER,
      driver: "claude",
      label: "Work",
      enabled: true,
      auth: { status: "unauthenticated", email: null, plan: null },
      createdAt: "2026-10-24T10:00:00Z",
    },
  ]);
  const keys = vi.fn(async () => ({ platform: "openrouter", apiKey: "private-api-key" }) as const);
  const subscriptions = new SubscriptionAccess({
    accounts,
    providers: new Map([
      ["claude", [{ id: "native-fixture", label: "Native fixture", supportsImages: true }]],
    ]),
  });
  const access = new ExecutionAccess({
    keys,
    subscriptions,
    allowedModels: ["api-fixture", "demo"],
    defaultModel: "api-fixture",
    freeModel: "demo",
  });
  return { accounts, keys, access };
}
it("resolves a native selection without opening an API key", async () => {
  const f = fixture();
  await f.accounts.completeSignIn(FAKE_OWNER, ACCOUNT, {
    generation: 0,
    credentials: { ciphertext: "sealed-native-grant", iv: "grant-iv" },
    identity: { email: "verified@example.com", plan: null },
  });
  const result = await f.access.resolve({
    userId: FAKE_OWNER,
    isAnonymous: false,
    choice: {
      kind: "explicit",
      selection: { kind: "subscription", accountId: ACCOUNT, model: "native-fixture" },
    },
  });
  expect(result).toEqual({
    ok: true,
    value: {
      kind: "subscription",
      driver: "claude",
      accountId: ACCOUNT,
      model: "native-fixture",
      generation: 1,
    },
  });
  expect(f.keys).not.toHaveBeenCalled();
  expect(JSON.stringify(result)).not.toContain("sealed-native-grant");
});
it("does not replace an unavailable subscription or an omitted native choice with API billing", async () => {
  const f = fixture();
  const selection = { kind: "subscription", accountId: ACCOUNT, model: "native-fixture" } as const;
  expect(
    await f.access.resolve({
      userId: FAKE_OWNER,
      isAnonymous: false,
      choice: { kind: "explicit", selection },
    }),
  ).toMatchObject({ ok: false, error: { code: "provider_sign_in_required" } });
  expect(
    await f.access.resolve({
      userId: FAKE_OWNER,
      isAnonymous: false,
      preference: selection,
      choice: { kind: "legacy", model: "api-fixture" },
    }),
  ).toMatchObject({ ok: false, error: { code: "execution_selection_required" } });
  expect(f.keys).not.toHaveBeenCalled();
});
it("allows an explicit API choice and returns only its billing decision", async () => {
  const f = fixture();
  const result = await f.access.resolve({
    userId: FAKE_OWNER,
    isAnonymous: false,
    choice: { kind: "explicit", selection: { kind: "api", model: "api-fixture" } },
  });
  expect(result).toEqual({
    ok: true,
    value: { kind: "api", model: "api-fixture", billsToUser: true },
  });
  expect(f.keys).toHaveBeenCalledOnce();
  expect(JSON.stringify(result)).not.toContain("private-api-key");
});
