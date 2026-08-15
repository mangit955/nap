/**
 * Each rung of the ladder on its own, then the order between them.
 *
 * Gates are the part of the benchmark that says "no" — a run that scored well is still a
 * failure if the thing it built does not compile — so each one is exercised in both
 * directions: it fires when it should, and it stays silent when it should not. A gate that
 * only ever fires is indistinguishable from a bug.
 */

import { describe, expect, it } from "vitest";
import { applyGates, BUILD_FAILURE_SCORE_CAP, type GateInput } from "./gates.ts";
import type { CheckResult } from "./report.ts";

function check(overrides: Partial<CheckResult> = {}): CheckResult {
  return {
    checkId: "build",
    kind: "command",
    category: "functional",
    weight: 1,
    required: false,
    build: false,
    outcome: "passed",
    detail: "exit 0",
    ...overrides,
  };
}

/** A run that went perfectly, so any verdict other than a pass came from the gate under test. */
function clean(overrides: Partial<GateInput> = {}): GateInput {
  return {
    seed: { ok: true },
    turn: { ok: true },
    workspace: { ok: true },
    preview: null,
    browser: { ok: true },
    checks: [check()],
    score: 100,
    ...overrides,
  };
}

describe("with nothing to say, the ladder leaves the checks' own verdict alone", () => {
  it("passes a run whose checks all passed", () => {
    expect(applyGates(clean())).toEqual({
      status: "passed",
      score: 100,
      errorKind: null,
      gates: [],
      scoreCap: null,
    });
  });

  it("fails a run with a failed check, without any gate firing", () => {
    // The ordinary failure: no rule was invoked, the checks simply did not pass.
    const verdict = applyGates(clean({ checks: [check({ outcome: "failed" })], score: 0 }));
    expect(verdict.status).toBe("failed");
    expect(verdict.gates).toEqual([]);
  });

  it("does not treat an absent check as a failure", () => {
    // Absent means nobody asked. What it means for the run is the scoring engine's business
    // — it renormalises the category away — and the ladder must not add a second opinion.
    expect(applyGates(clean({ checks: [check({ outcome: "absent" })] })).status).toBe("passed");
  });
});

describe("the turn gate", () => {
  it("errors a run whose turn failed, with the kind its reason maps to", () => {
    const verdict = applyGates(clean({ turn: { ok: false, reason: "sandbox_unavailable" } }));

    expect(verdict).toEqual({
      status: "errored",
      score: null,
      errorKind: "sandbox",
      gates: ["turn_failed"],
      scoreCap: null,
    });
  });

  it("throws away the score, however well the checks did", () => {
    // The distinction the benchmark rests on. A turn that never completed produced no
    // observation, so a number here would be a measurement of nothing.
    const verdict = applyGates(clean({ turn: { ok: false, reason: "refusal" }, score: 90 }));
    expect(verdict.score).toBeNull();
  });

  it("records a cancelled turn as a cancelled run rather than an error", () => {
    const verdict = applyGates(clean({ turn: { ok: false, reason: "cancelled" } }));

    expect(verdict).toEqual({
      status: "cancelled",
      score: null,
      errorKind: null,
      gates: ["turn_cancelled"],
      scoreCap: null,
    });
  });
});

describe("the workspace gate", () => {
  it("blames configuration when there was no such session", () => {
    const verdict = applyGates(clean({ workspace: { ok: false, missing: "session" } }));
    expect(verdict.status).toBe("errored");
    expect(verdict.errorKind).toBe("configuration");
    expect(verdict.gates).toEqual(["workspace_missing"]);
  });

  it("blames the execution plane when the sandbox went away", () => {
    const verdict = applyGates(clean({ workspace: { ok: false, missing: "sandbox" } }));
    expect(verdict.errorKind).toBe("sandbox");
  });
});

describe("the preview gate", () => {
  it("fails the run when the application did not start", () => {
    // Failed, not errored: this *is* an observation, and it is the worst one an agent can
    // produce. It keeps its score so the report still says what did work.
    const verdict = applyGates(
      clean({ preview: { state: "not_started", detail: "nothing listening" }, score: 80 }),
    );

    expect(verdict.status).toBe("failed");
    expect(verdict.errorKind).toBeNull();
    expect(verdict.gates).toEqual(["preview_not_started"]);
    expect(verdict.score).toBe(80);
  });

  it("errors with kind sandbox when the preview could not be reached", () => {
    // The same symptom from the host as the case above and the opposite attribution: the
    // application is up and the proxy in front of it is not. Charging that to the agent is
    // the single most likely way this benchmark could libel a model.
    const verdict = applyGates(
      clean({ preview: { state: "unreachable", detail: "listening but not answering" } }),
    );

    expect(verdict).toEqual({
      status: "errored",
      score: null,
      errorKind: "sandbox",
      gates: ["preview_unreachable"],
      scoreCap: null,
    });
  });

  it("says nothing about a preview that served", () => {
    const verdict = applyGates(
      clean({ preview: { state: "serving", url: "https://5173-abc.sandbox.invalid" } }),
    );
    expect(verdict.status).toBe("passed");
    expect(verdict.gates).toEqual([]);
  });
});

describe("the browser gate", () => {
  it("errors with kind browser when the driver would not run", () => {
    // Not a failed check: an evaluator that cannot see is not evidence about the application,
    // and recording it as one would be a permanent accusation with nothing behind it.
    const verdict = applyGates(
      clean({ browser: { ok: false, reason: "unavailable", detail: "no Chrome at that path" } }),
    );

    expect(verdict).toEqual({
      status: "errored",
      score: null,
      errorKind: "browser",
      gates: ["browser_unavailable"],
      scoreCap: null,
    });
  });

  it("blames the configuration when nobody supplied a browser at all", () => {
    // The same missing browser, a different fault: one is the host, one is the run being set
    // up to measure something it was never given the means to measure.
    const verdict = applyGates(
      clean({ browser: { ok: false, reason: "not_configured", detail: "no factory" } }),
    );

    expect(verdict.errorKind).toBe("configuration");
    expect(verdict.gates).toEqual(["browser_unavailable"]);
  });

  it("says nothing when the run had a browser, or never needed one", () => {
    expect(applyGates(clean()).gates).toEqual([]);
  });

  it("is not reached by a run whose preview could not be reached", () => {
    // Order: an unreachable sandbox explains a run better than the browser it never got to
    // use, and only one of the two may be reported.
    const verdict = applyGates(
      clean({
        preview: { state: "unreachable", detail: "no answer" },
        browser: { ok: false, reason: "unavailable", detail: "no Chrome" },
      }),
    );

    expect(verdict.gates).toEqual(["preview_unreachable"]);
    expect(verdict.errorKind).toBe("sandbox");
  });
});

describe("the measurable gate", () => {
  it("errors a run where nothing produced a result", () => {
    // Not a zero. Zero means every check was asked and none passed; this means none were
    // asked, which is a task written wrong rather than an agent that did badly.
    const verdict = applyGates(clean({ checks: [], score: null }));

    expect(verdict.status).toBe("errored");
    expect(verdict.errorKind).toBe("configuration");
    expect(verdict.gates).toEqual(["nothing_measurable"]);
  });
});

describe("the required-check gate", () => {
  it("fails a high-scoring run when a required check failed", () => {
    // The gate's whole reason to exist: the number says 92 and the answer is still no.
    const verdict = applyGates(
      clean({
        checks: [
          check({ checkId: "renders", required: true, outcome: "failed" }),
          check({ checkId: "lint", category: "code" }),
        ],
        score: 92,
      }),
    );

    expect(verdict.status).toBe("failed");
    expect(verdict.gates).toEqual(["required_check_failed"]);
    // Failing is the whole penalty. Required is not the build gate, and inventing a second
    // cap here would make two rules out of one decision.
    expect(verdict.score).toBe(92);
  });

  it("stays silent when the required check passed", () => {
    const verdict = applyGates(clean({ checks: [check({ required: true })] }));
    expect(verdict.gates).toEqual([]);
  });

  it("stays silent when the check that failed was not required", () => {
    const verdict = applyGates(clean({ checks: [check({ outcome: "failed" })], score: 0 }));
    expect(verdict.gates).toEqual([]);
  });
});

describe("the build gate", () => {
  it("fails the run and caps the score when the build failed", () => {
    const verdict = applyGates(
      clean({
        checks: [
          check({ checkId: "build", build: true, outcome: "failed" }),
          check({ checkId: "lint", category: "code" }),
        ],
        score: 85,
      }),
    );

    expect(verdict.status).toBe("failed");
    expect(verdict.gates).toEqual(["build_failed"]);
    // Recorded as well as applied, so a reader of the report can get from the check list to
    // the headline without knowing this constant.
    expect(verdict.scoreCap).toBe(BUILD_FAILURE_SCORE_CAP);
    expect(verdict.score).toBe(BUILD_FAILURE_SCORE_CAP);
  });

  it("caps rather than sets, so a bad run is not lifted to the cap", () => {
    const verdict = applyGates(
      clean({ checks: [check({ build: true, outcome: "failed" })], score: 12 }),
    );
    expect(verdict.score).toBe(12);
  });

  it("stays silent when the build passed", () => {
    const verdict = applyGates(clean({ checks: [check({ build: true })] }));
    expect(verdict.gates).toEqual([]);
    expect(verdict.score).toBe(100);
  });
});

describe("the order between gates", () => {
  it("reports the turn's failure rather than the checks', when both are true", () => {
    // A turn that failed explains the run; a required check that failed afterwards is a
    // consequence of it. Reporting the second would attribute an outage to the agent.
    const verdict = applyGates(
      clean({
        turn: { ok: false, reason: "model_unavailable" },
        checks: [check({ required: true, build: true, outcome: "failed" })],
        score: 0,
      }),
    );

    expect(verdict.gates).toEqual(["turn_failed"]);
    expect(verdict.errorKind).toBe("model");
  });

  it("reports an unreachable preview rather than the checks that failed because of it", () => {
    const verdict = applyGates(
      clean({
        preview: { state: "unreachable", detail: "no answer" },
        checks: [check({ required: true, outcome: "failed" })],
        score: 0,
      }),
    );

    expect(verdict.gates).toEqual(["preview_unreachable"]);
  });

  it("records every non-terminal gate that fired, in ladder order", () => {
    // Both are true and both are worth knowing: the app never came up *and* it does not
    // build. A report that named only one would send somebody looking in the wrong place.
    const verdict = applyGates(
      clean({
        preview: { state: "not_started", detail: "nothing listening" },
        checks: [
          check({ checkId: "renders", required: true, outcome: "failed" }),
          check({ checkId: "build", build: true, outcome: "failed" }),
        ],
        score: 90,
      }),
    );

    expect(verdict.gates).toEqual(["preview_not_started", "required_check_failed", "build_failed"]);
    expect(verdict.score).toBe(BUILD_FAILURE_SCORE_CAP);
  });
});

describe("the seed gate", () => {
  it("errors a run whose declared starting state never landed", () => {
    const verdict = applyGates(clean({ seed: { ok: false, detail: "the sandbox went away" } }));

    expect(verdict.status).toBe("errored");
    expect(verdict.gates).toEqual(["seed_failed"]);
    expect(verdict.score).toBeNull();
  });

  it("blames the execution plane rather than the agent", () => {
    // The task validated at import, so the paths and contents were well-formed; what is left
    // is the sandbox refusing the write. Charging that to the model is the error that quietly
    // corrupts a benchmark.
    const verdict = applyGates(clean({ seed: { ok: false, detail: "no space" } }));

    expect(verdict.errorKind).toBe("sandbox");
  });

  it("outranks everything else, because nothing after it is evidence about the agent", () => {
    // Both true at once: the seeding failed *and* the checks did badly. Only the first is a
    // fact about the run, since the agent was never shown the state the task describes.
    const verdict = applyGates(
      clean({
        seed: { ok: false, detail: "no space" },
        turn: { ok: false, reason: "refusal" },
        checks: [check({ outcome: "failed", required: true })],
        score: 0,
      }),
    );

    expect(verdict.gates).toEqual(["seed_failed"]);
    expect(verdict.errorKind).toBe("sandbox");
  });

  it("says nothing about a run that seeded nothing", () => {
    expect(applyGates(clean()).gates).toEqual([]);
  });
});
