import { benchReport } from "@nap/bench/testing/bench-report";
import { describe, expect, it } from "vitest";
import {
  napbenchArgv,
  parseTrialArgs,
  rewardDecisionFor,
  rewardPath,
  TRIAL_REPORT_FILE,
  trialArtefacts,
  trialPaths,
} from "./trial.ts";

describe("parsing a trial's command line", () => {
  it("reads a run's task and job directory", () => {
    const parsed = parseTrialArgs(["run", "--task=todo-crud", "--job-dir=/jobs/t1/agent"]);

    expect(parsed).toEqual({
      ok: true,
      value: {
        kind: "run",
        taskId: "todo-crud",
        jobDir: "/jobs/t1/agent",
        napbenchFlags: [],
      },
    });
  });

  it("passes everything after `--` to the benchmark untouched", () => {
    const parsed = parseTrialArgs([
      "run",
      "--task=todo-crud",
      "--job-dir=/jobs/t1/agent",
      "--",
      "--real",
      "--model=openai/gpt-5.6-luna",
    ]);

    expect(parsed.ok && parsed.value.kind === "run" && parsed.value.napbenchFlags).toEqual([
      "--real",
      "--model=openai/gpt-5.6-luna",
    ]);
  });

  /** The flag that spends money belongs to one parser, and it is not this one. */
  it("refuses a benchmark flag written before the separator", () => {
    const parsed = parseTrialArgs(["run", "--task=x", "--job-dir=/d", "--real"]);

    expect(parsed.ok).toBe(false);
  });

  it("refuses a run with no task", () => {
    expect(parseTrialArgs(["run", "--job-dir=/d"]).ok).toBe(false);
  });

  it("refuses a run with nowhere to write", () => {
    expect(parseTrialArgs(["run", "--task=x"]).ok).toBe(false);
  });

  it("reads a verification's two directories", () => {
    const parsed = parseTrialArgs([
      "verify",
      "--job-dir=/logs/agent",
      "--reward-dir=/logs/verifier",
    ]);

    expect(parsed).toEqual({
      ok: true,
      value: { kind: "verify", jobDir: "/logs/agent", rewardDir: "/logs/verifier" },
    });
  });

  it("refuses a verification with nowhere to put the reward", () => {
    expect(parseTrialArgs(["verify", "--job-dir=/logs/agent"]).ok).toBe(false);
  });

  it("refuses a misspelled flag rather than defaulting it", () => {
    expect(parseTrialArgs(["run", "--task=x", "--jobdir=/d"]).ok).toBe(false);
  });

  it("refuses a subcommand it does not have", () => {
    expect(parseTrialArgs(["score", "--job-dir=/d"]).ok).toBe(false);
  });

  it("refuses no subcommand at all", () => {
    expect(parseTrialArgs([]).ok).toBe(false);
  });
});

describe("a trial's job layout", () => {
  it("puts the report, the trajectory and the log in the job directory", () => {
    expect(trialPaths("/jobs/t1/agent")).toEqual({
      report: `/jobs/t1/agent/${TRIAL_REPORT_FILE}`,
      trajectory: "/jobs/t1/agent/trajectory.json",
      log: "/jobs/t1/agent/trial.log",
    });
  });

  it("puts the reward where the harness reads it, not beside the report", () => {
    expect(rewardPath("/logs/verifier")).toBe("/logs/verifier/reward.json");
  });
});

describe("the benchmark invocation a trial makes", () => {
  it("runs exactly one task, with the flags it was handed", () => {
    const parsed = parseTrialArgs(["run", "--task=reading-list", "--job-dir=/d", "--", "--real"]);
    if (!parsed.ok || parsed.value.kind !== "run") throw new Error("expected a run");

    expect(napbenchArgv(parsed.value)).toEqual(["--real", "reading-list"]);
  });

  /** A suite would produce several reports and one reward, which is unreadable downstream. */
  it("never asks for a suite", () => {
    const parsed = parseTrialArgs(["run", "--task=reading-list", "--job-dir=/d"]);
    if (!parsed.ok || parsed.value.kind !== "run") throw new Error("expected a run");

    expect(napbenchArgv(parsed.value).some((arg) => arg.startsWith("--suite"))).toBe(false);
  });
});

describe("finding what a run left in the job directory", () => {
  const runId = "9f1c2a5e-3b7d-4c1a-8f2e-6d0b4a9c7e13";

  it("finds the report and the trajectory the run wrote", () => {
    expect(
      trialArtefacts("todo-crud", [
        `todo-crud-${runId}.json`,
        `todo-crud-${runId}.trajectory.json`,
      ]),
    ).toEqual({
      report: `todo-crud-${runId}.json`,
      trajectory: `todo-crud-${runId}.trajectory.json`,
    });
  });

  /**
   * The failure this function exists for: a run writes a sidecar per screenshot into the same
   * directory, and a looser match files one of those as the trial's report. The trial then
   * reads as failed because the verifier cannot parse a screenshot descriptor.
   */
  it("never mistakes a screenshot's sidecar for the report", () => {
    const found = trialArtefacts("todo-crud", [
      `todo-crud-${runId}-adds-a-todo.png.json`,
      `todo-crud-${runId}-surface@home@mobile.png.json`,
      `todo-crud-${runId}.json`,
    ]);

    expect(found.report).toBe(`todo-crud-${runId}.json`);
  });

  it("finds nothing when the run wrote nothing", () => {
    expect(trialArtefacts("todo-crud", [`todo-crud-${runId}-home.png`])).toEqual({});
  });

  it("ignores another task's report, whatever else is in the directory", () => {
    expect(trialArtefacts("todo-crud", [`landing-page-${runId}.json`])).toEqual({});
  });
});

describe("deciding what a trial is worth", () => {
  it("writes the reward a scored run projects to", () => {
    const decision = rewardDecisionFor(benchReport({ score: 88 }));
    if (!decision.written) throw new Error("expected a reward");

    expect(JSON.parse(decision.body).overall).toBeCloseTo(0.88);
  });

  it("ends the file with a newline, because people read it", () => {
    const decision = rewardDecisionFor(benchReport({ score: 88 }));

    expect(decision.written && decision.body.endsWith("\n")).toBe(true);
  });

  /**
   * The rule the migration turns on: a trial that measured nothing writes no reward file, and
   * never a zero. A zero would file our bad afternoon against the model.
   */
  it("writes nothing for a run the benchmark itself broke on", () => {
    const decision = rewardDecisionFor(
      benchReport({ status: "errored", errorKind: "evaluator", score: null, scoreCap: null }),
    );

    expect(decision.written).toBe(false);
  });

  it("writes nothing for a cancelled run", () => {
    const decision = rewardDecisionFor(benchReport({ status: "cancelled", score: null }));

    expect(decision.written).toBe(false);
  });

  it("says both what happened and whose failure it was", () => {
    const decision = rewardDecisionFor(
      benchReport({ status: "errored", errorKind: "sandbox", score: null, scoreCap: null }),
    );
    if (decision.written) throw new Error("expected a refusal");

    expect(decision.reason).toContain("errored");
    expect(decision.reason).toContain("sandbox");
  });
});
