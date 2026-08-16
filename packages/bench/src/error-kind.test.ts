/**
 * Every mapping from a turn's failure reason, one case each.
 *
 * Exhaustive on purpose: the mapping is the thing that decides whether an outage counts
 * against a model, so a reason nobody wrote a case for is a reason nobody has checked.
 */

import type { TurnFailureReason } from "@nap/shared/events";
import { TurnFailureReasonSchema } from "@nap/shared/events";
import { describe, expect, it } from "vitest";
import {
  attributionOf,
  dispositionForTurnFailure,
  ERROR_KINDS,
  ErrorKindSchema,
} from "./error-kind.ts";

describe("error kinds", () => {
  it("are the seven the vocabulary names", () => {
    expect([...ERROR_KINDS]).toEqual([
      "agent",
      "runtime",
      "model",
      "sandbox",
      "browser",
      "evaluator",
      "configuration",
    ]);
  });

  it("rejects anything else", () => {
    expect(ErrorKindSchema.safeParse("infrastructure").success).toBe(false);
  });

  it("still accepts every kind a report on disk could already be carrying", () => {
    // The seventh kind was a *widening*, which is the only reason the three funded runs are
    // still readable. A rename would have made every archived report unparseable, and a
    // comparison against one of them impossible — so the guard is that nothing was removed.
    for (const kind of ["agent", "model", "sandbox", "browser", "evaluator", "configuration"]) {
      expect(ErrorKindSchema.safeParse(kind).success).toBe(true);
    }
  });
});

describe("dispositionForTurnFailure", () => {
  it("blames the agent for refusing", () => {
    expect(dispositionForTurnFailure("refusal")).toEqual({ status: "errored", errorKind: "agent" });
  });

  it("blames the agent for spending its budget without arriving", () => {
    expect(dispositionForTurnFailure("budget_exceeded")).toEqual({
      status: "errored",
      errorKind: "agent",
    });
  });

  it("blames the provider, not the model, for an outage", () => {
    // The case the whole mapping exists for: a model nobody could reach must not be
    // recorded as a model that failed the task.
    expect(dispositionForTurnFailure("model_unavailable")).toEqual({
      status: "errored",
      errorKind: "model",
    });
  });

  it("blames the execution plane for a sandbox that would not start", () => {
    expect(dispositionForTurnFailure("sandbox_unavailable")).toEqual({
      status: "errored",
      errorKind: "sandbox",
    });
  });

  it("files an internal fault against the system under test, and not against the model", () => {
    // The kind exists because both of the obvious answers were wrong. `evaluator` is reserved
    // for NapBench's own crashes, so using it here would file a bug in the system under test
    // as a bug in the instrument. `agent` — what this used to be — is worse: the agent may
    // have written perfect code and had the runtime fall over underneath it, and recording
    // that as evidence about the model is the one thing this module exists to prevent.
    expect(dispositionForTurnFailure("internal")).toEqual({
      status: "errored",
      errorKind: "runtime",
    });
  });

  it("records a cancelled turn as a cancelled run rather than an error", () => {
    expect(dispositionForTurnFailure("cancelled")).toEqual({
      status: "cancelled",
      errorKind: null,
    });
  });

  it("has a case for every reason the event contract can produce", () => {
    // Guards against the mapping and the contract drifting apart. The `switch` is exhaustive
    // at compile time; this is the same claim at runtime, so a reason added without a case
    // fails loudly here even if somebody silenced the type error.
    for (const reason of TurnFailureReasonSchema.options as TurnFailureReason[]) {
      const disposition = dispositionForTurnFailure(reason);
      expect(disposition.status === "errored" ? disposition.errorKind : null).not.toBe(undefined);
    }
  });
});

describe("attributionOf", () => {
  it("counts only the agent's own failures against the agent", () => {
    // A refusal and an exhausted budget are the two things the agent does wrong on its own.
    expect(attributionOf("agent")).toBe("agent");
  });

  it("counts a provider outage as infrastructure, not as the model being bad", () => {
    // The distinction the whole error-kind model exists for: a throttled provider must not
    // depress the measured quality of the model it was throttling.
    expect(attributionOf("model")).toBe("infrastructure");
  });

  it("counts a Nap runtime fault as infrastructure, so it never reaches the model's column", () => {
    // NapBench measures the model with Nap held fixed, so Nap's own machinery is apparatus.
    // A suite carrying a lot of this is a deployment to fix rather than a model to rank —
    // which is a different reading from a suite carrying a lot of `agent`, and the whole
    // reason the two are separate kinds.
    expect(attributionOf("runtime")).toBe("infrastructure");
  });

  it("counts everything that is not the agent as infrastructure", () => {
    for (const kind of ERROR_KINDS) {
      if (kind === "agent") continue;
      expect(attributionOf(kind)).toBe("infrastructure");
    }
  });
});
