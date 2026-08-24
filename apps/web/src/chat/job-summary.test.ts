/**
 * The strip's wording, tested where it is decided.
 *
 * A `.test.ts` under `apps/web`: this is a pure function of a fold's output, so it belongs to
 * the `unit` project. What the strip *looks* like is `job-strip.test.tsx`.
 *
 * The fixtures are built by folding real events rather than by hand-writing a `SessionJobs`,
 * because the interesting cases here are exactly the ones `foldJobs` decides — an all-absent
 * verification folds to `verified`, and a hand-written state would let this agree with a fold
 * that says something else.
 */

import { foldJobs } from "@nap/shared/job-state";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { beforeEach, describe, expect, it } from "vitest";
import { check, JOB_ID as JOB, jobLog, OTHER_JOB_ID as OTHER_JOB } from "../testing/job-events.ts";
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

describe("the checks", () => {
  it("carries the newest verification's findings, in order", () => {
    const summary = summarise(
      log.opened(),
      log.at("verification.completed", {
        jobId: JOB,
        checks: [
          check("typecheck", "passed"),
          check("test", "failed", "1 failed"),
          check("build", "absent"),
        ],
      }),
    );

    expect(summary?.checks.map((c) => [c.name, c.outcome])).toEqual([
      ["typecheck", "passed"],
      ["test", "failed"],
      ["build", "absent"],
    ]);
  });

  it("has none before anything has been run", () => {
    expect(summarise(log.opened())?.checks).toEqual([]);
  });
});

describe("repairs used", () => {
  it("says nothing when none has been spent", () => {
    expect(summarise(log.opened())?.attemptsLabel).toBeNull();
  });

  it("counts a repair from the verification that followed it", () => {
    // `started - 1`: every verification after the first was preceded by a repair turn. See
    // `foldJobs`.
    const summary = summarise(
      log.opened(),
      log.at("verification.started", { jobId: JOB }),
      log.at("verification.completed", { jobId: JOB, checks: [check("test", "failed", "boom")] }),
      log.at("verification.started", { jobId: JOB }),
      log.at("verification.completed", { jobId: JOB, checks: [check("test", "failed", "boom")] }),
    );

    expect(summary?.attemptsLabel).toBe("1 of 3 repairs used");
  });
});

describe("whether the project is at a verified state", () => {
  it("says so plainly when nothing has been committed", () => {
    expect(summarise(log.opened())?.state).toMatch(/nothing committed/i);
  });

  it("reports a checkpointed HEAD as verified", () => {
    const summary = summarise(
      log.opened(),
      log.committed("abc123"),
      log.at("verification.completed", { jobId: JOB, checks: [check("test", "passed")] }),
      log.at("job.checkpointed", { jobId: JOB, commitSha: "abc123" }),
    );

    expect(summary?.state).toMatch(/your last commit is verified/i);
  });

  it("keeps describing the last commit while the next job is still working", () => {
    // The phase above says the job is unfinished while this says the commit under it is fine,
    // and the two are only distinguishable if the sentence names what it is about. See
    // `stateLine`.
    const summary = summarise(
      log.opened(JOB),
      log.committed("abc123"),
      log.at("verification.completed", { jobId: JOB, checks: [check("test", "passed")] }),
      log.at("job.checkpointed", { jobId: JOB, commitSha: "abc123" }),
      log.at("job.completed", { jobId: JOB, outcome: "verified" }),
      log.opened(OTHER_JOB, "add a dark mode"),
    );

    expect(summary?.phase).toBe("working");
    expect(summary?.state).toMatch(/your last commit is verified/i);
  });

  it("never claims a verification for a job whose checks were all absent", () => {
    // The fold calls this `verified` and is right to — an unasked check is not a failed one
    // — but nothing ran, and a strip saying the commit passed the project's checks would be the
    // system claiming to have found what it never looked for.
    const summary = summarise(
      log.opened(),
      log.committed("abc123"),
      log.at("verification.completed", {
        jobId: JOB,
        checks: [check("typecheck", "absent"), check("test", "absent")],
      }),
      log.at("job.checkpointed", { jobId: JOB, commitSha: "abc123" }),
    );

    expect(summary?.phase).toBe("verified");
    expect(summary?.state).toMatch(/^this project declares no checks/i);
    expect(summary?.state).toMatch(/your last commit/i);
    expect(summary?.state).not.toMatch(/passed/i);
  });

  it("says nothing has passed yet when a commit has never been checkpointed", () => {
    const summary = summarise(log.opened(), log.committed("abc123"));

    expect(summary?.state).toMatch(/^your last commit is not verified/i);
    expect(summary?.state).toMatch(/nothing here has passed/i);
  });

  it("says HEAD has moved on when a later commit is not the checkpoint", () => {
    // Exhaustion leaves exactly this: code committed, nothing reverted, and a HEAD that has
    // diverged from the last thing anything agreed with (`docs/adr/0006`).
    const summary = summarise(
      log.opened(),
      log.committed("abc123"),
      log.at("job.checkpointed", { jobId: JOB, commitSha: "abc123" }),
      log.committed("def456"),
    );

    expect(summary?.state).toMatch(/^your last commit is not verified/i);
    expect(summary?.state).toMatch(/ahead of the last checkpoint/i);
  });
});
