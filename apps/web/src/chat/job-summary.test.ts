/**
 * The workspace bar's wording for a job, tested where it is decided.
 *
 * A `.test.ts` under `apps/web`: this is a pure function of a fold's output, so it belongs to
 * the `unit` project.
 *
 * The fixtures are built by folding real events rather than by hand-writing a `SessionJobs`,
 * because the interesting cases here are exactly the ones `foldJobs` decides — an all-absent
 * verification folds to `verified`, and a hand-written state would let this agree with a fold
 * that says something else.
 */

import { foldJobs } from "@nap/shared/job-state";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { beforeEach, describe, expect, it } from "vitest";
import { JOB_ID as JOB, jobLog, OTHER_JOB_ID as OTHER_JOB } from "../testing/job-events.ts";
import { jobSummary } from "./job-summary.ts";

let log = jobLog();

function summarise(...events: StoredEvent[]) {
  return jobSummary(foldJobs(events));
}

beforeEach(() => {
  log = jobLog();
});

describe("which job it describes", () => {
  it("says nothing about a session that has opened none", () => {
    expect(summarise()).toBeNull();
  });

  it("describes the newest, because a session runs one at a time", () => {
    // The older job is finished and its phase would be the wrong answer about the project.
    const summary = summarise(
      log.opened(JOB),
      log.at("job.completed", { jobId: JOB, outcome: "verified" }),
      log.opened(OTHER_JOB, "add a dark mode"),
    );

    expect(summary?.phase).toBe("working");
  });
});

describe("the phase", () => {
  it("is open while the job can still do something", () => {
    const summary = summarise(log.opened(), log.at("verification.started", { jobId: JOB }));

    expect(summary).toMatchObject({ phase: "verifying", phaseLabel: "Verifying", open: true });
  });

  it("is closed once the job has ended", () => {
    const summary = summarise(
      log.opened(),
      log.at("job.completed", { jobId: JOB, outcome: "exhausted" }),
    );

    expect(summary).toMatchObject({
      phase: "exhausted",
      phaseLabel: "Out of repairs",
      open: false,
    });
  });
});
