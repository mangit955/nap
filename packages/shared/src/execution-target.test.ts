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
