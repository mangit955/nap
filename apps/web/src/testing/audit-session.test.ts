/**
 * The kept session still matches the event contract.
 *
 * A fixture nobody wrote is a fixture nobody will notice going stale. If `NapEvent` gains a
 * required field, every suite reading this log keeps passing while rendering a shape the system
 * no longer produces — so the log is parsed against the real schema here, once, loudly.
 *
 * The counts are asserted too. They are what make this log worth keeping rather than
 * regenerating: a run where nothing failed would not exercise the panels this is for, and it
 * would be easy to replace this file with a tidier one and never notice the red row had gone.
 */

import { foldJobs } from "@nap/shared/job-state";
import { describe, expect, it } from "vitest";
import { auditSession, auditSessionIssues } from "./audit-session.ts";

describe("the kept audit session", () => {
  it("is a valid event log", () => {
    expect(auditSessionIssues()).toEqual([]);
  });

  it("is in sequence order, with no gaps", () => {
    const seqs = auditSession().map((event) => event.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(seqs).toEqual(seqs.map((_, index) => index + 1));
  });

  it("holds four jobs, one of which did not reach a checkpoint", () => {
    const state = foldJobs(auditSession());
    expect(state.jobs).toHaveLength(4);

    const phases = state.jobs.map((job) => job.phase);
    expect(phases.filter((phase) => phase === "verified")).toHaveLength(3);
    // The reason this log was kept. A history panel built only against green rows is a panel
    // whose failure case nobody looked at.
    expect(phases).toContain("abandoned");
  });

  it("holds a verification whose checks are not all the same", () => {
    // `absent` beside `passed` in one real result — the pair `docs/adr/0002` is about, and the
    // one most expensive to confuse. Worth having an unconstructed instance of.
    const outcomes = new Set(
      foldJobs(auditSession()).jobs.flatMap((job) => job.checks.map((check) => check.outcome)),
    );
    expect(outcomes).toContain("passed");
    expect(outcomes).toContain("absent");
  });

  it("ends at a checkpoint, because the failed turn committed nothing", () => {
    // The property that makes the abandoned job safe to show: a failed turn commits nothing,
    // so HEAD is still the last verified commit and the strip may honestly say so.
    const state = foldJobs(auditSession());
    expect(state.checkpointSha).not.toBeNull();
    expect(state.atCheckpoint).toBe(true);
  });
});
