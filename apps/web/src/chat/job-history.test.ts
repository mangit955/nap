/**
 * The history's contents, tested where they are decided.
 *
 * A `.test.ts` under `apps/web`: a pure function of a fold's output belongs to the `unit`
 * project. What the list *looks* like is `job-history.test.tsx`.
 *
 * Built by folding real events rather than by hand-writing a `SessionJobs`, for the reason
 * `job-summary.test.ts` gives: the interesting cases are the ones `foldJobs` decides, and a
 * hand-written state is free to disagree with it.
 */

import { foldJobs } from "@nap/shared/job-state";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { beforeEach, describe, expect, it } from "vitest";
import { auditSession } from "../testing/audit-session.ts";
import { check, JOB_ID as JOB, jobLog, OTHER_JOB_ID as OTHER_JOB } from "../testing/job-events.ts";
import { historyLabel, jobHistory } from "./job-history.ts";

const FILE = { path: "src/App.tsx", changeType: "modified" as const, diff: "" };

let log = jobLog();

function history(...events: StoredEvent[]) {
  return jobHistory(foldJobs(events));
}

function label(...events: StoredEvent[]) {
  return historyLabel(foldJobs(events));
}

beforeEach(() => {
  log = jobLog();
});

describe("which jobs it lists", () => {
  it("lists none for a session that has opened none", () => {
    expect(history()).toEqual([]);
  });

  it("lists every job, not only the ones that reached a checkpoint", () => {
    // The whole point of the panel. `job.checkpointed` is written on the success path only, so
    // a list built from checkpoints is a list with every failure deleted from it.
    const entries = history(
      log.opened(JOB, "build a finance dashboard"),
      log.checkpointed("abc1234567"),
      log.at("job.completed", { jobId: JOB, outcome: "verified" }),
      log.opened(OTHER_JOB, "add a dark mode toggle"),
      log.at("job.completed", { jobId: OTHER_JOB, outcome: "abandoned" }),
    );

    expect(entries.map((entry) => entry.objective)).toEqual([
      "add a dark mode toggle",
      "build a finance dashboard",
    ]);
  });

  it("puts the newest first and numbers from the oldest", () => {
    // Two different orders on purpose: reading order is newest-first, but a job's number is the
    // one it was given when it opened and must not change when the next one opens over it.
    const entries = history(
      log.opened(JOB),
      log.at("job.completed", { jobId: JOB, outcome: "verified" }),
      log.opened(OTHER_JOB),
    );

    expect(entries.map((entry) => entry.ordinal)).toEqual([2, 1]);
  });

  it("marks the job still in flight as open rather than as an outcome", () => {
    const [newest] = history(log.opened(JOB), log.at("verification.started", { jobId: JOB }));

    expect(newest).toMatchObject({ phase: "verifying", phaseLabel: "Verifying", open: true });
  });
});

describe("what an entry says", () => {
  it("carries the checkpoint the job itself produced", () => {
    const [entry] = history(
      log.opened(),
      log.committed("841f4d74962d8f3078f092b8873324f176acbe0b"),
      log.verified([check("test", "passed")]),
      log.checkpointed("841f4d74962d8f3078f092b8873324f176acbe0b"),
      log.at("job.completed", { jobId: JOB, outcome: "verified" }),
    );

    expect(entry?.checkpoint).toBe("841f4d7");
  });

  it("gives no checkpoint to a job that produced none, even after one exists", () => {
    // The session-wide sha survives a failed job, correctly — but printing it under the failed
    // job's own row would credit it with a commit it never made.
    const entries = history(
      log.opened(JOB),
      log.checkpointed("abc1234567", JOB),
      log.at("job.completed", { jobId: JOB, outcome: "verified" }),
      log.opened(OTHER_JOB),
      log.at("job.completed", { jobId: OTHER_JOB, outcome: "abandoned" }),
    );

    expect(entries[0]?.checkpoint).toBeNull();
    expect(entries[1]?.checkpoint).toBe("abc1234");
  });

  it("keeps the checks the job ended on", () => {
    const [entry] = history(
      log.opened(),
      log.verified([check("typecheck", "passed"), check("test", "absent")]),
      log.at("job.completed", { jobId: JOB, outcome: "verified" }),
    );

    expect(entry?.checks.map((one) => one.name)).toEqual(["typecheck", "test"]);
  });

  it("says how many repairs a job spent, in the strip's words", () => {
    const [entry] = history(
      log.opened(),
      log.at("verification.started", { jobId: JOB }),
      log.verified([check("test", "failed")]),
      log.at("verification.started", { jobId: JOB }),
      log.verified([check("test", "failed")]),
    );

    expect(entry?.attemptsLabel).toBe("1 of 3 repairs used");
  });

  it("says nothing about repairs on a job that needed none", () => {
    const [entry] = history(log.opened(), log.verified([check("test", "passed")]));

    expect(entry?.attemptsLabel).toBeNull();
  });

  it("counts the files the job touched, in the singular when there is one", () => {
    const [entry] = history(log.opened(), log.at("file.changed", FILE));

    expect(entry?.filesLabel).toBe("1 file changed");
  });

  it("says nothing about files for a job that changed none", () => {
    const [entry] = history(log.opened());

    expect(entry?.filesLabel).toBeNull();
  });

  it("carries the moment the job opened, and a time somebody can read", () => {
    const [entry] = history(log.opened());

    expect(entry?.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entry?.clock).toMatch(/\d{1,2}[:.]\d{2}/);
  });
});

describe("against the session that was kept", () => {
  // The one log here nobody wrote. Constructed events are uniformly tidier than this — four
  // real objectives, three checkpoints and a job that ran out of budget — and the panel exists
  // for exactly the shape a fixture would not think to build.
  const kept = () => jobHistory(foldJobs([...auditSession()]));

  it("lists all four of its jobs, the one that failed at the top", () => {
    const entries = kept();

    expect(entries).toHaveLength(4);
    expect(entries[0]).toMatchObject({ ordinal: 4, phaseLabel: "Abandoned", failed: true });
  });

  it("gives each verified job its own sha and the abandoned one none", () => {
    expect(kept().map((entry) => entry.checkpoint)).toEqual([
      null,
      "53b7b0c",
      "5b0df78",
      "841f4d7",
    ]);
  });

  it("offers the newest checkpoint as the way in, counting only the three that happened", () => {
    expect(historyLabel(foldJobs([...auditSession()]))).toBe("Checkpoint 3 · 53b7b0c");
  });
});

describe("the affordance on the strip's own face", () => {
  it("offers nothing while there is only one job to see", () => {
    // A strip that expands into a list of one is a control that does nothing.
    expect(label(log.opened())).toBeNull();
  });

  it("names the newest checkpoint, and which number it is", () => {
    // The fact people want most, doubling as the thing to click. Two jobs, one checkpoint.
    const found = label(
      log.opened(JOB),
      log.checkpointed("abc1234567", JOB),
      log.at("job.completed", { jobId: JOB, outcome: "verified" }),
      log.opened(OTHER_JOB),
    );

    expect(found).toBe("Checkpoint 1 · abc1234");
  });

  it("counts checkpoints rather than jobs, so a failure does not advance the number", () => {
    const found = label(
      log.opened(JOB),
      log.checkpointed("abc1234567", JOB),
      log.at("job.completed", { jobId: JOB, outcome: "verified" }),
      log.opened(OTHER_JOB),
      log.at("job.completed", { jobId: OTHER_JOB, outcome: "abandoned" }),
      log.opened("c3f0e1d2-1111-4222-8333-444455556666"),
      log.checkpointed("def4567890", "c3f0e1d2-1111-4222-8333-444455556666"),
    );

    expect(found).toBe("Checkpoint 2 · def4567");
  });

  it("falls back to counting jobs when nothing has been checkpointed yet", () => {
    const found = label(
      log.opened(JOB),
      log.at("job.completed", { jobId: JOB, outcome: "abandoned" }),
      log.opened(OTHER_JOB),
    );

    expect(found).toBe("2 jobs");
  });
});
