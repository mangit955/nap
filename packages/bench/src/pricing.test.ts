import { billedWeightsFor, MODEL_BILLED_WEIGHTS } from "@nap/shared/usage";
import { describe, expect, it } from "vitest";
import { estimateCost, MODEL_PRICES, PRICE_TABLE_VERSION } from "./pricing.ts";

const MILLION = { inputTokens: 1_000_000, outputTokens: 1_000_000 };

describe("estimateCost", () => {
  it("multiplies token counts by the table's per-million price", () => {
    // A million of each is exactly the two rates added together, which is the arithmetic
    // stated in a form somebody can check against the table by eye.
    const price = MODEL_PRICES["openai/gpt-5.6-luna"];

    expect(estimateCost("openai/gpt-5.6-luna", MILLION)?.usd).toBe(
      price.inputPerMTokUsd + price.outputPerMTokUsd,
    );
  });

  it("prices cached input at what the cache bills it, not at the full input rate", () => {
    // A million tokens of prompt, nine tenths of it read from the cache and a tenth written to
    // it. Before the split this whole million was priced as uncached input.
    const price = MODEL_PRICES["anthropic/claude-opus-5"];
    const estimate = estimateCost("anthropic/claude-opus-5", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 900_000,
      cacheWriteTokens: 100_000,
    });

    expect(estimate?.usd).toBeCloseTo(price.inputPerMTokUsd * (0.9 * 0.1 + 0.1 * 1.25), 5);
  });

  it("prices an OpenAI model's cached input by that model's own weights", () => {
    const price = MODEL_PRICES["openai/gpt-5.6-terra"];
    const estimate = estimateCost("openai/gpt-5.6-terra", {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cacheReadTokens: 900_000,
      cacheWriteTokens: 100_000,
    });

    expect(estimate?.usd).toBeCloseTo(price.inputPerMTokUsd * (0.9 * 0.1 + 0.1 * 1.25), 5);
  });

  it("prices usage from before the split exactly as it always did", () => {
    const price = MODEL_PRICES["anthropic/claude-opus-5"];

    expect(estimateCost("anthropic/claude-opus-5", MILLION)?.usd).toBe(
      price.inputPerMTokUsd + price.outputPerMTokUsd,
    );
  });

  it("keeps a cheap turn from rounding away to zero", () => {
    // A debug-model turn costs thousandths of a cent. Rounded to the cent it would be free,
    // and a suite of them would report as free too.
    const estimate = estimateCost("openai/gpt-5.6-luna", {
      inputTokens: 2_000,
      outputTokens: 500,
    });

    expect(estimate?.usd).toBeGreaterThan(0);
  });

  it("records the model and the price table that produced it", () => {
    const estimate = estimateCost("anthropic/claude-opus-5", MILLION);

    expect(estimate?.model).toBe("anthropic/claude-opus-5");
    expect(estimate?.priceTableVersion).toBe(PRICE_TABLE_VERSION);
  });

  it("prices the two models differently, which is why the model is recorded", () => {
    const cheap = estimateCost("openai/gpt-5.6-luna", MILLION)?.usd ?? 0;
    const dear = estimateCost("anthropic/claude-opus-5", MILLION)?.usd ?? 0;

    expect(dear).toBeGreaterThan(cheap * 10);
  });

  it("prices the model the funded before/after measurement was taken on", () => {
    // The hard suite's two arms were bought on this one, and a report from a funded run
    // carrying no cost figure is the one place the gap actually costs something: the whole
    // point of that measurement is a number somebody can quote, price included.
    const price = MODEL_PRICES["openai/gpt-5.6-terra"];

    expect(estimateCost("openai/gpt-5.6-terra", MILLION)?.usd).toBe(
      price.inputPerMTokUsd + price.outputPerMTokUsd,
    );
  });

  it("returns nothing for a model the table does not price", () => {
    // Not zero, and not a guess from a similar model: a confident wrong figure in an
    // archived report is worse than a gap somebody can see.
    expect(estimateCost("openai/gpt-4o-mini", MILLION)).toBeUndefined();
  });

  it("does not price a model named after something every object has", () => {
    // A model id arrives from a CLI flag. Looked up through an index signature, `toString`
    // hands back a function, and the estimate becomes NaN in an archived report.
    expect(estimateCost("toString", MILLION)).toBeUndefined();
    expect(estimateCost("constructor", MILLION)).toBeUndefined();
  });

  it("returns nothing when no model was recorded", () => {
    expect(estimateCost(undefined, MILLION)).toBeUndefined();
  });

  it("returns nothing when the token counts it depends on are absent", () => {
    // ADR-0003: a failed turn carries no usage, so it carries no cost either.
    expect(estimateCost("openai/gpt-5.6-luna", undefined)).toBeUndefined();
  });
});

describe("the price table and the budget's weights", () => {
  // Two tables about the same models, in two packages. The budget charges output at a weight and
  // the estimate prices it from a rate; if one were repriced without the other, a turn's budget
  // would stop meaning what its estimate says it cost.
  it("name exactly the same models", () => {
    expect(Object.keys(MODEL_BILLED_WEIGHTS).sort()).toEqual(Object.keys(MODEL_PRICES).sort());
  });

  it("agree, model by model, on what output costs relative to input", () => {
    for (const [model, price] of Object.entries(MODEL_PRICES))
      expect(price.outputPerMTokUsd / price.inputPerMTokUsd, model).toBeCloseTo(
        billedWeightsFor(model).output,
        9,
      );
  });
});
