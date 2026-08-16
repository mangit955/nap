import { describe, expect, it } from "vitest";
import {
  budgetsDiffer,
  describeTurnBudget,
  parseRunConfiguration,
  UNRECORDED_CONFIGURATION,
} from "./run-configuration.ts";

const BUDGET = { maxSteps: 40, maxTokens: 400_000 };

describe("run configuration", () => {
  it("accepts a fully recorded configuration", () => {
    const parsed = parseRunConfiguration({ model: "openai/gpt-5.6-luna", budget: BUDGET });
    expect(parsed.ok).toBe(true);
  });

  it("accepts a configuration that recorded neither", () => {
    // What a run composed without either looks like, and what an archived report is read as.
    expect(parseRunConfiguration(UNRECORDED_CONFIGURATION).ok).toBe(true);
  });

  it("refuses a budget that is not a whole positive number of steps", () => {
    // A ceiling of zero or a fractional one is a configuration nobody meant, and recording it
    // would put a number in an archived artefact that no run could have been held at.
    expect(parseRunConfiguration({ model: null, budget: { ...BUDGET, maxSteps: 0 } }).ok).toBe(
      false,
    );
    expect(parseRunConfiguration({ model: null, budget: { ...BUDGET, maxSteps: 1.5 } }).ok).toBe(
      false,
    );
  });

  it("refuses an empty model rather than treating it as unrecorded", () => {
    // Null and "" would otherwise both mean "no model named", and only one of them survives a
    // round trip through a report as the thing it was.
    expect(parseRunConfiguration({ model: "", budget: null }).ok).toBe(false);
  });
});

describe("budgetsDiffer", () => {
  it("is false for two runs held at the same ceilings", () => {
    expect(budgetsDiffer(BUDGET, { ...BUDGET })).toBe(false);
  });

  it("is true when either ceiling moved", () => {
    expect(budgetsDiffer(BUDGET, { ...BUDGET, maxSteps: 8 })).toBe(true);
    expect(budgetsDiffer(BUDGET, { ...BUDGET, maxTokens: 40_000 })).toBe(true);
  });

  it("is false whenever either side never recorded one", () => {
    // Not "differ" but "cannot tell", and the two must not be conflated: every report written
    // before the configuration existed has a null budget, and answering true here would make
    // all of them permanently incomparable with everything that came after.
    expect(budgetsDiffer(null, BUDGET)).toBe(false);
    expect(budgetsDiffer(BUDGET, null)).toBe(false);
    expect(budgetsDiffer(null, null)).toBe(false);
  });
});

describe("describeTurnBudget", () => {
  it("names both ceilings, since either can be the one that was hit", () => {
    expect(describeTurnBudget(BUDGET)).toBe("40 steps / 400000 tokens");
  });

  it("says so when there was none recorded", () => {
    expect(describeTurnBudget(null)).toBe("unrecorded");
  });
});
