import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { estimateCost } from "@nap/shared/pricing";
import { describe, expect, it } from "vitest";
import {
  failureKind,
  readJob,
  renderReport,
  summarise,
  type TrialRecord,
  wilsonInterval,
} from "./harbor-report.ts";
import { SCRIPTED_MODEL } from "./harbor-task-args.ts";
import type { TaskTurnResult } from "./task-turn.ts";

const MODEL = "openai/gpt-6-luna";

function nap(overrides: Partial<TaskTurnResult> = {}): TaskTurnResult {
  return {
    status: "completed",
    failure: null,
    model: MODEL,
    requests: 8,
    steps: 8,
    usage: { inputTokens: 100_000, outputTokens: 5_000, cacheReadTokens: 80_000 },
    durationMs: 60_000,
    workdir: "/app",
    ...overrides,
  };
}

function trial(overrides: Partial<TrialRecord> = {}): TrialRecord {
  return {
    task: "terminal-bench/regex-log",
    trial: "regex-log__abc",
    reward: 1,
    exception: null,
    nap: nap(),
    ...overrides,
  };
}

const failedOn = (reason: string): TaskTurnResult =>
  nap({ status: "failed", failure: { reason, message: "…" } });

describe("wilsonInterval", () => {
  it("brackets the observed rate and stays inside 0 to 1", () => {
    const { low, high } = wilsonInterval(7, 25);
    expect(low).toBeLessThan(7 / 25);
    expect(high).toBeGreaterThan(7 / 25);
    expect(wilsonInterval(0, 25).low).toBe(0);
    expect(wilsonInterval(25, 25).high).toBeCloseTo(1, 12);
  });

  it("is about twenty points either side at n=25, which is why one run proves little", () => {
    // The published Wilson interval for 7 of 25 at 95%: 0.143 to 0.476.
    const { low, high } = wilsonInterval(7, 25);
    expect(low).toBeCloseTo(0.143, 3);
    expect(high).toBeCloseTo(0.476, 3);
  });

  it("has no interval for no trials", () => {
    expect(wilsonInterval(0, 0)).toEqual({ low: 0, high: 1 });
  });
});

describe("failureKind", () => {
  it.each<[string, Partial<TrialRecord>, ReturnType<typeof failureKind>]>([
    ["a pass", {}, null],
    [
      "Harbor's own timeout, whatever Nap wrote",
      { reward: 0, exception: "AgentTimeoutError", nap: failedOn("cancelled") },
      "harbor_timeout",
    ],
    [
      "an environment that never came up",
      { reward: null, exception: "RuntimeError", nap: null },
      "harness_error",
    ],
    ["the step budget", { reward: 0, nap: failedOn("budget_exceeded") }, "step_budget"],
    [
      "the model unreachable",
      { reward: 0, nap: failedOn("model_unavailable") },
      "model_unavailable",
    ],
    ["a claim of done the tests refuted", { reward: 0 }, "claimed_done_tests_failed"],
    ["any other failed turn", { reward: 0, nap: failedOn("internal") }, "turn_failed"],
    ["no result from the agent", { reward: 0, nap: null }, "no_agent_result"],
    ["no reward and no exception", { reward: null }, "not_scored"],
  ])("files %s", (_name, overrides, kind) => {
    expect(failureKind(trial(overrides))).toBe(kind);
  });
});

describe("summarise", () => {
  const trials = [
    trial({ task: "terminal-bench/a" }),
    trial({ task: "terminal-bench/b", reward: 0 }),
    trial({ task: "terminal-bench/c", reward: 0, nap: failedOn("budget_exceeded") }),
    trial({ task: "terminal-bench/d", reward: null, exception: "RuntimeError", nap: null }),
    trial({ task: "terminal-bench/e", trial: null, reward: null, nap: null }),
  ];
  const report = summarise(trials);

  it("counts every planned trial in the pass rate, harness errors and unfinished ones as failures", () => {
    expect(report.trials).toBe(5);
    expect(report.passed).toBe(1);
    expect(report.passRate).toBe(0.2);
    expect(report.interval).toEqual(wilsonInterval(1, 5));
    expect(report.harnessErrors).toBe(1);
    expect(report.unfinished).toBe(1);
  });

  it("crosses Nap's claim of done with the hidden tests, over the trials Nap ran", () => {
    // d (the harness failed) and e (never finished) made no claim either way: counting them as
    // "did not claim, failed" would make a flakier harness look like a more honest agent.
    expect(report.agreement).toEqual({
      claimedPassed: 1,
      claimedFailed: 1,
      unclaimedPassed: 0,
      unclaimedFailed: 1,
      rate: 2 / 3,
      notRun: 2,
    });
  });

  it("prices what Nap counted, and says how many trials it could not price", () => {
    const one = estimateCost(MODEL, nap().usage)?.usd ?? Number.NaN;
    expect(report.cost.usd).toBeCloseTo(one * 3, 5);
    expect(report.cost.perPricedTrialUsd).toBeCloseTo(one, 5);
    expect(report.cost.priced).toBe(3);
    expect(report.cost.unpriced).toBe(2);
    expect(report.cost.priceTableVersion).not.toBe("");
  });

  it("groups failures by kind with their tasks", () => {
    expect(report.failures).toEqual({
      claimed_done_tests_failed: ["terminal-bench/b"],
      step_budget: ["terminal-bench/c"],
      harness_error: ["terminal-bench/d"],
      unfinished: ["terminal-bench/e"],
    });
  });

  it("names every model the trials ran on", () => {
    expect(report.models).toEqual([MODEL]);
  });

  it("leaves a paid model with no price out of the cost rather than guessing", () => {
    const unknown = summarise([trial({ nap: nap({ model: "vendor/unpriced" }) })]);
    expect(unknown.cost).toMatchObject({ usd: 0, priced: 0, unpriced: 1, perPricedTrialUsd: null });
  });

  it("prices a free model's trials at nothing, since that is what they cost", () => {
    const free = summarise([trial({ nap: nap({ model: "vendor/m:free" }) })]);
    expect(free.cost).toMatchObject({ usd: 0, priced: 1, unpriced: 0, perPricedTrialUsd: 0 });
  });
});

describe("renderReport", () => {
  it("says what the interval means and states each headline figure", () => {
    const text = renderReport(summarise([trial(), trial({ task: "terminal-bench/b", reward: 0 })]));
    expect(text).toContain("1 of 2 passed (50.0%)");
    expect(text).toContain("95% interval");
    expect(text).toContain("Claimed done");
    expect(text).toContain("| terminal-bench/b |");
    expect(text).not.toContain("Incomplete");
  });

  it("says in the headline when the job stopped before every trial finished", () => {
    const text = renderReport(
      summarise([
        trial(),
        trial({ task: "terminal-bench/b", trial: null, reward: null, nap: null }),
      ]),
    );
    expect(text).toContain("1 of 2 passed");
    expect(text).toContain("Incomplete: 1 of 2 planned trials never finished");
  });
});

describe("renderReport on a scripted run", () => {
  it("says the figures mean nothing, and that nothing was priced", () => {
    const text = renderReport(summarise([trial({ nap: nap({ model: SCRIPTED_MODEL }) })]));
    expect(text).toContain("say nothing about the agent");
    expect(text).toContain("No trial could be priced");
  });
});

describe("readJob", () => {
  function write(path: string, body: unknown) {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, typeof body === "string" ? body : JSON.stringify(body));
  }

  it("reads each trial's reward, exception and Nap result, and skips the job's own files", () => {
    const job = mkdtempSync(join(tmpdir(), "harbor-job-"));
    write(join(job, "result.json"), { n_total_trials: 2 });
    write(join(job, "regex-log__abc", "result.json"), {
      task_name: "terminal-bench/regex-log",
      trial_name: "regex-log__abc",
      verifier_result: { rewards: { reward: 1.0 } },
      exception_info: null,
    });
    write(join(job, "regex-log__abc", "agent", "nap-result.json"), nap());
    write(join(job, "fix-git__x", "result.json"), {
      task_name: "terminal-bench/fix-git",
      trial_name: "fix-git__x",
      verifier_result: null,
      exception_info: { exception_type: "RuntimeError", exception_message: "compose failed" },
    });

    expect(readJob(job).trials).toEqual([
      {
        task: "terminal-bench/fix-git",
        trial: "fix-git__x",
        reward: null,
        exception: "RuntimeError",
        nap: null,
      },
      {
        task: "terminal-bench/regex-log",
        trial: "regex-log__abc",
        reward: 1,
        exception: null,
        nap: nap(),
      },
    ]);
  });

  it("treats a Nap result that does not parse as no result, not as a crash", () => {
    const job = mkdtempSync(join(tmpdir(), "harbor-job-"));
    write(join(job, "t__1", "result.json"), { task_name: "terminal-bench/t", trial_name: "t__1" });
    write(join(job, "t__1", "agent", "nap-result.json"), "{not json");
    expect(readJob(job).trials[0]?.nap).toBeNull();
  });

  it("adds a record for each planned task with no finished trial, and names the dataset", () => {
    const job = mkdtempSync(join(tmpdir(), "harbor-job-"));
    write(join(job, "config.json"), {
      datasets: [
        {
          name: "terminal-bench/terminal-bench-2-1",
          ref: "sha256:abc",
          task_names: ["terminal-bench/t", "terminal-bench/never-ran"],
        },
      ],
    });
    write(join(job, "t__1", "result.json"), { task_name: "terminal-bench/t", trial_name: "t__1" });

    const record = readJob(job);
    expect(record.dataset).toBe("terminal-bench/terminal-bench-2-1@sha256:abc");
    expect(record.trials.map((t) => [t.task, t.trial])).toEqual([
      ["terminal-bench/t", "t__1"],
      ["terminal-bench/never-ran", null],
    ]);
  });
});
