import { describe, expect, it } from "vitest";
import {
  budgetsDiffer,
  describeHarness,
  describeTurnBudget,
  harnessesDiffer,
  parseRunConfiguration,
  UNRECORDED_CONFIGURATION,
} from "./run-configuration.ts";

const BUDGET = { maxSteps: 40, maxTokens: 400_000 };
const HARNESS = {
  commit: "9e107d9d372bb6826bd81d3542a419d6c2b0f5a1",
  dirty: false,
  verification: true,
};

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

  it("accepts a recorded harness", () => {
    const parsed = parseRunConfiguration({ model: null, budget: null, harness: HARNESS });
    expect(parsed).toStrictEqual({
      ok: true,
      value: { model: null, budget: null, harness: HARNESS },
    });
  });

  it("reads a configuration written before the harness existed as unrecorded", () => {
    // The archive rule, applied to this field: a report from before V2 declared no harness, and
    // must keep parsing as having declared none rather than failing or inventing one.
    const parsed = parseRunConfiguration({ model: "openai/gpt-5.6-luna", budget: BUDGET });

    expect(parsed).toStrictEqual({
      ok: true,
      value: { model: "openai/gpt-5.6-luna", budget: BUDGET, harness: null },
    });
  });

  it("refuses a harness that names no commit", () => {
    // An identity with an empty sha identifies nothing, and would be a second spelling of
    // "unrecorded" that does not survive a round trip as the thing it was meant to be.
    expect(
      parseRunConfiguration({ model: null, budget: null, harness: { ...HARNESS, commit: "" } }).ok,
    ).toBe(false);
  });

  it("refuses a harness that does not say whether verification ran", () => {
    // The one field the funded before/after measurement tells its two arms apart by. Defaulting
    // it would put an arm label on a run nobody labelled.
    expect(
      parseRunConfiguration({
        model: null,
        budget: null,
        harness: { commit: HARNESS.commit, dirty: false },
      }).ok,
    ).toBe(false);
  });
});

describe("harnessesDiffer", () => {
  it("is false for two runs produced by the same Nap", () => {
    expect(harnessesDiffer(HARNESS, { ...HARNESS })).toBe(false);
  });

  it("is true when the commit moved, or when verification was on for one and not the other", () => {
    expect(harnessesDiffer(HARNESS, { ...HARNESS, commit: "0".repeat(40) })).toBe(true);
    expect(harnessesDiffer(HARNESS, { ...HARNESS, verification: false })).toBe(true);
  });

  it("is false whenever either side never recorded one", () => {
    // Not "differ" but "cannot tell", as with the budget: every pre-V2 report has a null
    // harness, and answering true would make all of them incomparable with everything after.
    expect(harnessesDiffer(null, HARNESS)).toBe(false);
    expect(harnessesDiffer(HARNESS, null)).toBe(false);
    expect(harnessesDiffer(null, null)).toBe(false);
  });

  it("is false for a modified tree, which is a sha to distrust rather than a difference", () => {
    expect(harnessesDiffer(HARNESS, { ...HARNESS, dirty: true })).toBe(false);
  });
});

describe("describeHarness", () => {
  it("names the commit and whether verification ran", () => {
    expect(describeHarness(HARNESS)).toBe("9e107d9d, verification on");
    expect(describeHarness({ ...HARNESS, verification: false })).toBe("9e107d9d, verification off");
  });

  it("says when the tree was modified, since the sha is then only approximate", () => {
    expect(describeHarness({ ...HARNESS, dirty: true })).toBe(
      "9e107d9d (modified), verification on",
    );
  });

  it("says so when there was none recorded", () => {
    expect(describeHarness(null)).toBe("unrecorded");
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
