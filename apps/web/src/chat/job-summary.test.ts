/**
 * The strip's wording, tested where it is decided.
 *
 * A `.test.ts` under `apps/web`: this is a pure function of a fold's output, so it belongs to
 * the `unit` project. What the strip *looks* like is `job-strip.test.tsx`.
 *
 * The fixtures are built by folding real events rather than by hand-writing a `SessionJobs`,
 * because the interesting cases here are exactly the ones `foldJobs` decides — an all-absent
 * verification folding to `verified` is the case this ticket exists to get right, and a
 * hand-written state would let the strip agree with a fold that says something else.
 */

import type { NapEvent, NapEventType } from "@nap/shared/events";
import { foldJobs } from "@nap/shared/job-state";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { beforeEach, describe, expect, it } from "vitest";
import { ev } from "../testing/events.ts";
import { jobSummary } from "./job-summary.ts";

const JOB = "5f6a7b8c-9d0e-4f10-a213-456789abcdef";
const OTHER_JOB = "6a7b8c9d-0e1f-4021-b324-56789abcdef0";

let nextSeq = 0;

function e<T extends NapEventType>(type: T, payload: Extract<NapEvent, { type: T }>["payload"]) {
  nextSeq += 1;
  // `as never` for the same reason the rest of the suite does it: `ev`'s generic cannot be
  // correlated through a second generic wrapper, and the call sites are still checked.
  return ev(type, payload as never, nextSeq);
}

function summarise(...events: StoredEvent[]) {
  return jobSummary(foldJobs(events));
}

const opened = (jobId = JOB, objective = "build a todo list") =>
  e("job.started", { jobId, objective });

const committed = (commitSha: string | null) =>
  e("turn.completed", {
    usage: { inputTokens: 1, outputTokens: 1 },
    durationMs: 10,
    commitSha,
  });

const check = (
  name: string,
  outcome: "passed" | "failed" | "absent",
  output: string | null = null,
) => ({ name, outcome, output }) as const;

beforeEach(() => {
  nextSeq = 0;
});

describe("which job it describes", () => {
  it("says nothing about a session that has opened none", () => {
    expect(summarise()).toBeNull();
  });

  it("describes the newest, because a session runs one at a time", () => {
    const summary = summarise(
      opened(JOB, "build a todo list"),
      e("job.completed", { jobId: JOB, outcome: "verified" }),
      opened(OTHER_JOB, "add a dark mode"),
    );

    expect(summary?.objective).toBe("add a dark mode");
  });
});

describe("the phase", () => {
  it("is open while the job can still do something", () => {
    const summary = summarise(opened(), e("verification.started", { jobId: JOB }));

    expect(summary).toMatchObject({ phase: "verifying", phaseLabel: "Verifying", open: true });
  });

  it("is closed once the job has ended", () => {
    const summary = summarise(opened(), e("job.completed", { jobId: JOB, outcome: "exhausted" }));

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
      opened(),
      e("verification.completed", {
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
    expect(summarise(opened())?.checks).toEqual([]);
  });
});

describe("repairs used", () => {
  it("says nothing when none has been spent", () => {
    expect(summarise(opened())?.attemptsLabel).toBeNull();
  });

  it("counts a repair from the verification that followed it", () => {
    // `started - 1`: every verification after the first was preceded by a repair turn. See
    // `foldJobs`.
    const summary = summarise(
      opened(),
      e("verification.started", { jobId: JOB }),
      e("verification.completed", { jobId: JOB, checks: [check("test", "failed", "boom")] }),
      e("verification.started", { jobId: JOB }),
      e("verification.completed", { jobId: JOB, checks: [check("test", "failed", "boom")] }),
    );

    expect(summary?.attemptsLabel).toBe("1 of 3 repairs used");
  });
});

describe("whether the project is at a verified state", () => {
  it("says so plainly when nothing has been committed", () => {
    expect(summarise(opened())?.state).toMatch(/nothing committed/i);
  });

  it("reports a checkpointed HEAD as verified", () => {
    const summary = summarise(
      opened(),
      committed("abc123"),
      e("verification.completed", { jobId: JOB, checks: [check("test", "passed")] }),
      e("job.checkpointed", { jobId: JOB, commitSha: "abc123" }),
    );

    expect(summary?.state).toMatch(/at a verified state/i);
  });

  it("never claims a verification for a job whose checks were all absent", () => {
    // The Fog question this ticket answers. The fold calls it `verified` and is right to — an
    // unasked check is not a failed one — but nothing ran, and a strip saying the commit passed
    // the project's checks would be the system claiming to have found what it never looked for.
    const summary = summarise(
      opened(),
      committed("abc123"),
      e("verification.completed", {
        jobId: JOB,
        checks: [check("typecheck", "absent"), check("test", "absent")],
      }),
      e("job.checkpointed", { jobId: JOB, commitSha: "abc123" }),
    );

    expect(summary?.phase).toBe("verified");
    expect(summary?.state).toMatch(/declares no checks/i);
    expect(summary?.state).not.toMatch(/passed/i);
  });

  it("says nothing has passed yet when a commit has never been checkpointed", () => {
    const summary = summarise(opened(), committed("abc123"));

    expect(summary?.state).toMatch(/nothing committed here has passed/i);
  });

  it("says HEAD has moved on when a later commit is not the checkpoint", () => {
    // Exhaustion leaves exactly this: code committed, nothing reverted, and a HEAD that has
    // diverged from the last thing anything agreed with (`docs/adr/0006`).
    const summary = summarise(
      opened(),
      committed("abc123"),
      e("job.checkpointed", { jobId: JOB, commitSha: "abc123" }),
      committed("def456"),
    );

    expect(summary?.state).toMatch(/ahead of the last checkpoint/i);
  });
});
