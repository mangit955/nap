import { describe, expect, it } from "vitest";
import { compareRuns } from "./compare.ts";
import { scoringModelOf } from "./scoring-model.ts";
import { benchReport } from "./testing/bench-report.ts";

describe("the scoring model a report was written under", () => {
  /**
   * Not a guess: v2 did not exist when those reports were written, so the absence is itself
   * the evidence. Defaulting keeps the whole archive readable rather than stranding it behind
   * a field it could not have carried.
   */
  it("reads an unrecorded model as v1", () => {
    expect(scoringModelOf(undefined)).toBe("v1");
  });

  it("reads a recorded model as itself", () => {
    expect(scoringModelOf("v2")).toBe("v2");
    expect(scoringModelOf("v1")).toBe("v1");
  });
});

describe("comparing across scoring models", () => {
  /**
   * Both land on 0–100, which is exactly what makes this dangerous: the numbers look
   * comparable and are not. There is no question a v1-against-v2 delta answers.
   */
  it("refuses a v1 baseline against a v2 candidate", () => {
    const result = compareRuns(
      benchReport({ taskId: "todo-crud", score: 85 }),
      benchReport({
        taskId: "todo-crud",
        score: 49,
        scoringModel: "v2",
        halves: { objective: 95, product: 25 },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("different models");
  });

  it("refuses in the other direction too", () => {
    const result = compareRuns(
      benchReport({
        taskId: "todo-crud",
        score: 49,
        scoringModel: "v2",
        halves: { objective: 95, product: 25 },
      }),
      benchReport({ taskId: "todo-crud", score: 85 }),
    );

    expect(result.ok).toBe(false);
  });

  /**
   * The refusal must not depend on the score existing: two errored runs still carry an
   * attribution, and comparing those across instruments invites the same misreading.
   */
  it("refuses even when neither run was scored", () => {
    const result = compareRuns(
      benchReport({ taskId: "todo-crud", status: "errored", errorKind: "sandbox", score: null }),
      benchReport({
        taskId: "todo-crud",
        status: "errored",
        errorKind: "sandbox",
        score: null,
        scoringModel: "v2",
      }),
    );

    expect(result.ok).toBe(false);
  });

  it("allows two runs written under the same model", () => {
    const result = compareRuns(
      benchReport({
        taskId: "todo-crud",
        score: 40,
        scoringModel: "v2",
        halves: { objective: 80, product: 20 },
      }),
      benchReport({
        taskId: "todo-crud",
        score: 60,
        scoringModel: "v2",
        halves: { objective: 80, product: 45 },
      }),
    );

    expect(result.ok).toBe(true);
  });

  /** The frozen archive compares with itself exactly as it always did. */
  it("allows two unrecorded runs, which is the whole existing archive", () => {
    const result = compareRuns(
      benchReport({ taskId: "todo-crud", score: 88 }),
      benchReport({ taskId: "todo-crud", score: 74 }),
    );

    expect(result.ok).toBe(true);
  });
});
