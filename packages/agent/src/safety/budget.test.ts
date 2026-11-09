import { NapEventSchema } from "@nap/shared/events";
import { billedWeightsFor, FALLBACK_BILLED_WEIGHTS } from "@nap/shared/usage";
import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_STEPS, DEFAULT_MAX_TOKENS, TurnBudget } from "./budget.ts";

const OPUS = billedWeightsFor("anthropic/claude-opus-5");
/** The default model, so what the default budget allows is measured on what runs by default. */
const LUNA = billedWeightsFor("openai/gpt-5.6-luna");

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
    budget.recordUsage({ inputTokens: tokensPerStep, outputTokens: 0 }, OPUS);
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

  it("sums every part of usage across every call in the turn, each at its billed weight", () => {
    const budget = new TurnBudget();

    budget.recordUsage({ inputTokens: 30, outputTokens: 4 }, OPUS);
    budget.recordUsage({ inputTokens: 1000, outputTokens: 66 }, OPUS);

    // Uncached input at 1, output at Opus's 5.
    expect(budget.spent().tokens).toBe(30 + 4 * 5 + 1000 + 66 * 5);
  });

  it("charges a cache read a tenth of an uncached token and a cache write a quarter more", () => {
    const budget = new TurnBudget();

    budget.recordUsage(
      {
        inputTokens: 32_000,
        outputTokens: 0,
        cacheReadTokens: 30_000,
        cacheWriteTokens: 2_000,
      },
      OPUS,
    );

    expect(budget.spent().tokens).toBe(30_000 * 0.1 + 2_000 * 1.25);
  });

  it("charges output at the ratio of the model that wrote it", () => {
    const opus = new TurnBudget();
    const luna = new TurnBudget();
    const unknown = new TurnBudget();

    opus.recordUsage({ inputTokens: 0, outputTokens: 100 }, OPUS);
    luna.recordUsage({ inputTokens: 0, outputTokens: 100 }, LUNA);
    unknown.recordUsage({ inputTokens: 0, outputTokens: 100 }, FALLBACK_BILLED_WEIGHTS);

    expect(opus.spent().tokens).toBe(500);
    expect(luna.spent().tokens).toBe(600);
    expect(unknown.spent().tokens).toBe(600);
  });

  it("is never NaN or negative, whatever a provider reports", () => {
    const budget = new TurnBudget({ maxSteps: 5, maxTokens: 1_000 });

    budget.recordUsage({ inputTokens: Number.NaN, outputTokens: 1 }, OPUS);
    budget.recordUsage({ inputTokens: -500, outputTokens: -5 }, OPUS);
    budget.recordUsage({ inputTokens: 10, outputTokens: 0, cacheReadTokens: 1_000 }, OPUS);

    const { tokens: spent } = budget.spent();
    const { tokens: remaining } = budget.remaining();
    expect(Number.isFinite(spent) && spent >= 0).toBe(true);
    expect(Number.isFinite(remaining) && remaining >= 0).toBe(true);
    // And a NaN cannot slip a turn past its ceiling: every comparison with NaN is false.
    budget.recordUsage({ inputTokens: 2_000, outputTokens: 0 }, OPUS);
    expect(budget.check().ok).toBe(false);
  });

  it("never reports more remaining than the ceiling, or less than nothing", () => {
    const budget = new TurnBudget({ maxSteps: 5, maxTokens: 100 });

    expect(budget.remaining().tokens).toBe(100);
    budget.recordUsage({ inputTokens: 0, outputTokens: 1_000 }, OPUS);
    expect(budget.remaining().tokens).toBe(0);
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

    budget.recordUsage({ inputTokens: 400, outputTokens: 100 }, OPUS);
    const verdict = budget.check();

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.failure.reason).toBe("budget_exceeded");
    expect(verdict.failure.message).toContain("900");
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

    budget.recordUsage({ inputTokens: DEFAULT_MAX_TOKENS, outputTokens: 1 }, OPUS);

    expect(budget.check().ok).toBe(false);
  });
});

/**
 * One round trip of a turn whose cache is working: it re-reads the conversation so far from
 * the cache, writes what the last step added, and answers. `context` is the size of the prompt.
 */
function cachedStep(context: number, added: number, output: number) {
  return {
    inputTokens: context,
    outputTokens: output,
    cacheReadTokens: context - added,
    cacheWriteTokens: added,
  };
}

describe("TurnBudget — what the default allows", () => {
  it("lets a turn re-reading a cached 30k context reach its step limit", () => {
    // The case the old, unweighted budget got wrong: it charged every re-read token at face
    // value and stopped this turn around its thirteenth step, with most of the step limit unused.
    const budget = new TurnBudget();

    for (let step = 0; step < DEFAULT_MAX_STEPS; step += 1) {
      budget.recordStep();
      budget.recordUsage(cachedStep(30_000 + step * 1_500, 2_300, 800), LUNA);
      expect(budget.check(), `step ${step + 1}`).toEqual({ ok: true });
    }
  });

  it("stops a turn whose cache never hits before its step limit does", () => {
    // A runaway the step limit alone would let through at many times the cost: the same turn
    // with every request paying full price for its prompt.
    const budget = new TurnBudget();
    let steps = 0;

    while (budget.check().ok && steps < DEFAULT_MAX_STEPS) {
      budget.recordStep();
      budget.recordUsage({ inputTokens: 30_000 + steps * 1_500, outputTokens: 800 }, LUNA);
      steps += 1;
    }

    expect(budget.check().ok).toBe(false);
    expect(steps).toBeLessThan(DEFAULT_MAX_STEPS);
  });

  it("stops a turn that writes far more than any step needs to", () => {
    const budget = new TurnBudget();
    let steps = 0;

    while (budget.check().ok && steps < DEFAULT_MAX_STEPS) {
      budget.recordStep();
      budget.recordUsage(cachedStep(20_000, 1_000, 16_000), LUNA);
      steps += 1;
    }

    expect(budget.check().ok).toBe(false);
    expect(steps).toBeLessThan(DEFAULT_MAX_STEPS / 2);
  });
});
