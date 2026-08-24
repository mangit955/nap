/**
 * The rule that decides whether anything is said about your absence.
 *
 * Most of these tests assert that **nothing** is shown, which is the point: the card fires on a
 * conclusion, and a session where nothing concluded has nothing to report. Built by folding real
 * events for the reason `job-history.test.ts` gives — the interesting cases are the ones
 * `foldJobs` decides, and a hand-written state is free to disagree with it.
 */

import type { StoredEvent } from "@nap/shared/ports/event-store";
import { beforeEach, describe, expect, it } from "vitest";
import { check, JOB_ID as JOB, jobLog, OTHER_JOB_ID as OTHER_JOB } from "../testing/job-events.ts";
import { unseenSummary } from "./unseen-summary.ts";

const PASSED = [check("typecheck", "passed")];
const FAILED = [check("typecheck", "failed", "TS2304")];

let log = jobLog();

beforeEach(() => {
  log = jobLog();
});

/** A whole job that verified on the first attempt, ending at `job.completed`. */
function verifiedJob(): StoredEvent[] {
  return [
    log.opened(JOB, "build a todo list"),
    log.committed("abc12345678"),
    log.verified(PASSED),
    log.checkpointed("abc12345678"),
    log.at("job.completed", { jobId: JOB, outcome: "verified" }),
  ];
}

describe("when the card fires", () => {
  it("says nothing to a browser that has never opened this session", () => {
    // No cursor is not a cursor of zero: there is no place this reader left off, so there is
    // nothing they were away *from*. Same rule the seam obeys.
    expect(unseenSummary(verifiedJob(), undefined)).toBeNull();
  });

  it("says nothing when the job had already finished before you left", () => {
    // The four-hours-away case, and the one that makes this a rule about outcomes rather than
    // about elapsed time. Everything concluded below the cursor; nothing was decided in your
    // absence, so there is nothing to be told.
    const events = verifiedJob();
    const seen = events.at(-1)?.seq;

    expect(unseenSummary(events, seen)).toBeNull();
  });

  it("says nothing about activity that concluded nothing", () => {
    // A rule keyed on volume would read "while you were away: 47 events" — true, and worthless.
    // A job that is still working has decided nothing yet.
    const events = [
      log.opened(JOB, "build a todo list"),
      log.at("agent.message", { text: "Adding the list component." }),
      log.at("file.changed", { path: "src/App.tsx", changeType: "modified", diff: "" }),
    ];

    expect(unseenSummary(events, events[0]?.seq)).toBeNull();
  });

  it("fires on a job that verified in the ninety seconds you were gone", () => {
    const events = verifiedJob();

    // The cursor stood at the opening: the reader watched the job start and then left.
    const card = unseenSummary(events, events[0]?.seq);

    expect(card?.objective).toBe("build a todo list");
    expect(card?.failed).toBe(false);
  });

  it("fires on a checkpoint that a crash left unclosed", () => {
    // `job.completed` is the usual conclusion, but a worker that died after committing the
    // checkpoint left the strongest evidence in the log there is. Waiting for the tidier event
    // would be silence about the one thing that definitely happened.
    const events = [
      log.opened(JOB, "build a todo list"),
      log.committed("abc12345678"),
      log.verified(PASSED),
      log.checkpointed("abc12345678"),
    ];

    expect(unseenSummary(events, events[0]?.seq)).not.toBeNull();
  });

  it("describes the newest conclusion when two jobs closed while you were gone", () => {
    const events = [
      log.opened(JOB, "build a todo list"),
      log.at("job.completed", { jobId: JOB, outcome: "verified" }),
      log.opened(OTHER_JOB, "add a dark mode toggle"),
      log.at("job.completed", { jobId: OTHER_JOB, outcome: "abandoned" }),
    ];

    expect(unseenSummary(events, 0)?.objective).toBe("add a dark mode toggle");
  });
});

describe("what the card claims", () => {
  it("names the commit a verified job checkpointed, abbreviated", () => {
    const card = unseenSummary(verifiedJob(), 0);

    expect(card?.checkpoint).toBe("abc1234");
    expect(card?.outcome).toContain("verified");
  });

  it("claims no checkpoint for a job that reached none", () => {
    const events = [
      log.opened(JOB, "build a todo list"),
      log.at("job.completed", { jobId: JOB, outcome: "abandoned" }),
    ];

    const card = unseenSummary(events, 0);

    expect(card?.checkpoint).toBeNull();
    expect(card?.failed).toBe(true);
  });

  it("says nothing about repairs when none were spent", () => {
    // The whole reason the copy is singular: a job that went straight through has no such
    // sentence, and inventing "0 repairs" would be a line about nothing.
    expect(unseenSummary(verifiedJob(), 0)?.repairs).toBeNull();
  });

  it("counts one repair in words, and names what it fixed", () => {
    // The check's name is the one word in the sentence that says what was actually wrong — and
    // it is only in the round *before* the last one, which the fold discards.
    const events = [
      log.opened(JOB, "build a todo list"),
      log.committed("abc12345678"),
      log.verified(FAILED),
      log.at("turn.started", { source: "verification" }),
      log.committed("def45678901"),
      log.verified(PASSED),
      log.checkpointed("def45678901"),
      log.at("job.completed", { jobId: JOB, outcome: "verified" }),
    ];

    expect(unseenSummary(events, 0)?.repairs).toBe(
      "One repair was needed — typecheck failed, and was fixed.",
    );
  });

  it("says a job out of repairs spent them rather than needed them", () => {
    // "Three repairs were needed" reads as three repairs that worked. This one ran out.
    const events = [log.opened(JOB, "build a todo list"), log.committed("abc12345678")];
    for (let attempt = 0; attempt < 4; attempt++) {
      events.push(log.verified(FAILED));
      if (attempt < 3) events.push(log.at("turn.started", { source: "verification" }));
    }
    events.push(log.at("job.completed", { jobId: JOB, outcome: "exhausted" }));

    const card = unseenSummary(events, 0);

    expect(card?.repairs).toBe("Three repairs were spent — typecheck is still failing.");
    expect(card?.failed).toBe(true);
  });

  it("counts repairs it cannot name a cause for, and names none", () => {
    // A window that opens after the failing round: the repairs are still countable, because
    // they are derived from how many verifications were begun, but nothing in view says what
    // was wrong. Better an unadorned sentence than a check picked from somewhere else.
    const events = [
      log.opened(JOB, "build a todo list"),
      log.at("verification.started", { jobId: JOB }),
      log.verified(PASSED),
      log.at("verification.started", { jobId: JOB }),
      log.verified(PASSED),
      log.checkpointed("abc12345678"),
      log.at("job.completed", { jobId: JOB, outcome: "verified" }),
    ];

    expect(unseenSummary(events, 0)?.repairs).toBe("One repair was needed.");
  });
});

describe("a turn that failed", () => {
  it("says what failed when no job was ever opened", () => {
    // The sandbox never came up, so there is no job and no objective — the runtime opens one
    // only once it has a workspace in hand. The card still fires: something was decided.
    const events = [
      log.at("user.message", { text: "build a todo list" }),
      log.at("turn.failed", { reason: "sandbox_unavailable", message: "" }),
    ];

    const card = unseenSummary(events, events[0]?.seq);

    expect(card?.objective).toBeNull();
    expect(card?.outcome).toBe("The workspace couldn't start.");
    expect(card?.failed).toBe(true);
  });

  it("keeps the objective when the job it belonged to is still open", () => {
    // A worker that died after writing `turn.failed` never wrote the `job.completed` that would
    // have closed the job. The objective is still knowable, so it is still said.
    const events = [
      log.opened(JOB, "build a todo list"),
      log.at("turn.failed", { reason: "internal", message: "boom" }),
    ];

    const card = unseenSummary(events, events[0]?.seq);

    expect(card?.objective).toBe("build a todo list");
    expect(card?.outcome).toBe("The agent stopped partway through.");
  });

  it("does not borrow the objective of a job that had already closed", () => {
    // The failed turn is the *next* prompt, whose job never opened. Reading the previous job's
    // objective would put somebody else's sentence under a failure it had nothing to do with.
    const events = [
      log.opened(JOB, "build a todo list"),
      log.at("job.completed", { jobId: JOB, outcome: "verified" }),
      log.at("user.message", { text: "add a dark mode toggle" }),
      log.at("turn.failed", { reason: "sandbox_unavailable", message: "no capacity" }),
    ];

    const card = unseenSummary(events, 2);

    expect(card?.objective).toBeNull();
  });
});
