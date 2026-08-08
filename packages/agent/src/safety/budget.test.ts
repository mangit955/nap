import { NapEventSchema } from "@nap/shared/events";
import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_STEPS, DEFAULT_MAX_TOKENS, TurnBudget } from "./budget.ts";

const SESSION_ID = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";
const TURN_ID = "7c9b1a52-8d3e-4f21-a0c4-1b2d3e4f5a6b";

/** Puts a verdict where it is going to end up, so the payload is proven to be a real event. */
function asTurnFailed(payload: unknown): unknown {
  return {
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    seq: 7,
    createdAt: "2026-01-01T00:00:00.000Z",
    type: "turn.failed",
    payload,
  };
}

function spend(budget: TurnBudget, steps: number, tokensPerStep = 0): void {
  for (let i = 0; i < steps; i += 1) {
    budget.recordStep();
    budget.recordUsage({ inputTokens: tokensPerStep, outputTokens: 0 });
  }
}

describe("TurnBudget", () => {
  it("starts empty", () => {
    expect(new TurnBudget().spent()).toEqual({ steps: 0, tokens: 0 });
  });

  it("allows a turn inside both limits", () => {
    const budget = new TurnBudget({ maxSteps: 5, maxTokens: 1000 });

    spend(budget, 4, 100);

    expect(budget.check()).toEqual({ ok: true });
  });

  it("allows a turn sitting exactly on both limits", () => {
    // The limit is what may be spent, not the first thing refused — otherwise every
    // configured number is quietly one less than it says.
    const budget = new TurnBudget({ maxSteps: 5, maxTokens: 500 });

    spend(budget, 5, 100);

    expect(budget.check()).toEqual({ ok: true });
  });

  it("sums both halves of usage across every call in the turn", () => {
    const budget = new TurnBudget();

    budget.recordUsage({ inputTokens: 30, outputTokens: 4 });
    budget.recordUsage({ inputTokens: 1000, outputTokens: 66 });

    expect(budget.spent().tokens).toBe(1100);
  });
});

describe("TurnBudget — exceeded", () => {
  it("fails the turn when the step budget runs out", () => {
    const budget = new TurnBudget({ maxSteps: 3, maxTokens: 1_000_000 });

    spend(budget, 4);
    const verdict = budget.check();

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.failure.reason).toBe("budget_exceeded");
    expect(verdict.failure.message).toContain("4");
    expect(verdict.failure.message).toContain("3");
    expect(NapEventSchema.safeParse(asTurnFailed(verdict.failure)).success).toBe(true);
  });

  it("fails the turn when the token budget runs out", () => {
    const budget = new TurnBudget({ maxSteps: 1000, maxTokens: 500 });

    budget.recordUsage({ inputTokens: 400, outputTokens: 200 });
    const verdict = budget.check();

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.failure.reason).toBe("budget_exceeded");
    expect(verdict.failure.message).toContain("600");
    expect(verdict.failure.message).toContain("500");
    expect(NapEventSchema.safeParse(asTurnFailed(verdict.failure)).success).toBe(true);
  });

  it("reports one reason when both budgets are blown, not two", () => {
    // A turn fails once. Which limit is named has to be deterministic or the failure
    // message depends on nothing the caller can see.
    const budget = new TurnBudget({ maxSteps: 1, maxTokens: 10 });

    spend(budget, 5, 100);
    const first = budget.check();
    const second = budget.check();

    expect(first).toEqual(second);
    expect(first.ok).toBe(false);
    if (first.ok) return;
    expect(first.failure.message).toContain("step");
  });

  it("stays failed once it has failed", () => {
    const budget = new TurnBudget({ maxSteps: 1, maxTokens: 1_000_000 });

    spend(budget, 2);

    expect(budget.check().ok).toBe(false);
    expect(budget.check().ok).toBe(false);
  });
});

describe("TurnBudget — defaults", () => {
  it("uses the exported limits when given none", () => {
    const budget = new TurnBudget();

    spend(budget, DEFAULT_MAX_STEPS);
    expect(budget.check()).toEqual({ ok: true });

    budget.recordStep();
    expect(budget.check().ok).toBe(false);
  });

  it("stops a turn that spends the token limit without taking many steps", () => {
    const budget = new TurnBudget();

    budget.recordUsage({ inputTokens: DEFAULT_MAX_TOKENS, outputTokens: 1 });

    expect(budget.check().ok).toBe(false);
  });
});
