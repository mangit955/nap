import { describe, expect, it } from "vitest";
import { ExecutionTargetSchema } from "./execution-target.ts";

describe("execution target boundary", () => {
  it("requires an explicit payer or a pinned subscription account", () => {
    expect(ExecutionTargetSchema.parse({ kind: "api", model: "demo", billsToUser: false })).toEqual(
      { kind: "api", model: "demo", billsToUser: false },
    );
    const subscription = {
      kind: "subscription",
      model: "claude-sonnet",
      driver: "claude",
      accountId: "00000000-0000-4000-8000-000000000001",
      generation: 3,
    };
    expect(ExecutionTargetSchema.parse(subscription)).toEqual(subscription);
    for (const value of [
      { ...subscription, generation: -1 },
      { ...subscription, generation: undefined },
      { ...subscription, accountId: undefined },
      { ...subscription, billsToUser: false },
      { kind: "api", model: "demo" },
    ]) {
      expect(ExecutionTargetSchema.safeParse(value).success).toBe(false);
    }
  });
});

it("compares target identity including account generation and API payer", async () => {
  const { sameExecutionTarget } = await import("./execution-target.ts");
  const target = {
    kind: "subscription",
    driver: "claude",
    accountId: "00000000-0000-4000-8000-000000000099",
    model: "claude-offline-fixture",
    generation: 4,
  } as const;
  expect(
    sameExecutionTarget(target, {
      generation: 4,
      model: target.model,
      accountId: target.accountId,
      driver: "claude",
      kind: "subscription",
    }),
  ).toBe(true);
  expect(sameExecutionTarget(target, { ...target, generation: 5 })).toBe(false);
  expect(sameExecutionTarget(target, { ...target, driver: "codex" })).toBe(false);
  expect(sameExecutionTarget(undefined, undefined)).toBe(true);
  expect(
    sameExecutionTarget(
      { kind: "api", model: "same-model", billsToUser: true },
      { kind: "api", model: "same-model", billsToUser: true },
    ),
  ).toBe(true);
  expect(
    sameExecutionTarget(target, { ...target, accountId: "00000000-0000-4000-8000-000000000098" }),
  ).toBe(false);
  expect(sameExecutionTarget(target, { ...target, model: "another-model" })).toBe(false);
  expect(sameExecutionTarget(target, undefined)).toBe(false);
  expect(
    sameExecutionTarget(
      { kind: "api", model: "same-model", billsToUser: true },
      { kind: "api", model: "same-model", billsToUser: false },
    ),
  ).toBe(false);
});
