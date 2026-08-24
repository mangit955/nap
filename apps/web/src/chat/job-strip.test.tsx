/**
 * What the strip puts on screen, queried the way somebody using a screen reader meets it.
 *
 * Every assertion here is by role and accessible name. The strip is four facts in a row of
 * small type, so a test anchored to markup would pass on a version of it that is unreachable
 * to a reader — and the phase is the one thing in the workspace that changes on its own, which
 * makes announcing it the point rather than a nicety.
 *
 * The states are built by folding real events, so the strip is checked against what `foldJobs`
 * actually produces rather than against a hand-written shape it might not.
 */

import type { StoredEvent } from "@nap/shared/ports/event-store";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { check, JOB_ID as JOB, jobLog, OTHER_JOB_ID as OTHER_JOB } from "../testing/job-events.ts";
import { JobStrip } from "./job-strip.tsx";
import { jobView } from "./job-summary.ts";

let log = jobLog();

function show(...events: StoredEvent[]) {
  // Derived here rather than by the strip, which now takes the workspace's one answer — see
  // `useSessionLog`. Still real events, so the strip is checked against what the fold produces.
  return render(<JobStrip jobs={jobView(events)} />);
}

beforeEach(() => {
  log = jobLog();
});

describe("when there is nothing to say", () => {
  it("draws no strip at all for a session with no job", () => {
    show();

    expect(screen.queryByRole("region", { name: /job status/i })).not.toBeInTheDocument();
  });
});

describe("the phase", () => {
  it("says what the job is doing", () => {
    show(log.opened(), log.at("verification.started", { jobId: JOB }));

    expect(screen.getByRole("region", { name: /job status/i })).toHaveTextContent(/verifying/i);
  });

  it("names the state a job ends in", () => {
    show(log.opened(), log.at("job.completed", { jobId: JOB, outcome: "exhausted" }));

    expect(screen.getByRole("region", { name: /job status/i })).toHaveTextContent(
      /out of repairs/i,
    );
  });

  it("does not announce it a second time", () => {
    // The workspace bar owns the live region: it is the surface that survives this pane being
    // collapsed, and two announcers would say one change twice.
    show(log.opened(), log.at("verification.started", { jobId: JOB }));

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });
});

describe("the checks", () => {
  it("lists each one with what it did, in words", () => {
    // Not by colour: `absent` and `failed` are the pair it is most expensive to confuse, and
    // one of them is not a failure at all.
    show(
      log.opened(),
      log.at("verification.completed", {
        jobId: JOB,
        checks: [check("typecheck", "passed"), check("test", "failed"), check("build", "absent")],
      }),
    );

    const checks = screen.getByRole("list", { name: /checks/i });
    expect(checks).toHaveTextContent(/typecheck\s*passed/);
    expect(checks).toHaveTextContent(/test\s*failed/);
    expect(checks).toHaveTextContent(/build\s*absent/);
  });

  it("shows no list before anything has run", () => {
    show(log.opened());

    expect(screen.queryByRole("list", { name: /checks/i })).not.toBeInTheDocument();
  });
});

describe("repairs used", () => {
  it("says how many of the three have been spent", () => {
    show(
      log.opened(),
      log.at("verification.started", { jobId: JOB }),
      log.at("verification.completed", { jobId: JOB, checks: [check("test", "failed")] }),
      log.at("verification.started", { jobId: JOB }),
      log.at("verification.completed", { jobId: JOB, checks: [check("test", "failed")] }),
    );

    expect(screen.getByRole("region", { name: /job status/i })).toHaveTextContent(
      /1 of 3 repairs used/,
    );
  });

  it("says nothing about repairs on a job that has needed none", () => {
    show(
      log.opened(),
      log.at("verification.completed", { jobId: JOB, checks: [check("test", "passed")] }),
    );

    expect(screen.getByRole("region", { name: /job status/i })).not.toHaveTextContent(/repairs/i);
  });
});

describe("the history behind it", () => {
  /** Two jobs, the first verified and the second still going. */
  const twoJobs = () => [
    log.opened(JOB, "build a finance dashboard"),
    log.committed("841f4d74962d8f3078f092b8873324f176acbe0b"),
    log.checkpointed("841f4d74962d8f3078f092b8873324f176acbe0b", JOB),
    log.at("job.completed", { jobId: JOB, outcome: "verified" }),
    log.opened(OTHER_JOB, "add a dark mode toggle"),
  ];

  it("offers nothing to expand while there has only been one job", () => {
    show(log.opened(), log.at("verification.completed", { jobId: JOB, checks: [] }));

    expect(screen.queryByRole("button", { name: /checkpoint|jobs/i })).not.toBeInTheDocument();
  });

  it("carries the newest checkpoint on its face once a second job exists", () => {
    // A strip that expands is a strip nobody clicks, so the control is the fact people want
    // most rather than a chevron labelled "History".
    show(...twoJobs());

    expect(screen.getByRole("button", { name: /checkpoint 1 · 841f4d7/i })).toHaveAttribute(
      "aria-expanded",
      "false",
    );
  });

  it("shows the past jobs once it is pressed, and hides them again", () => {
    show(...twoJobs());
    const toggle = screen.getByRole("button", { name: /checkpoint 1/i });

    expect(screen.queryByRole("list", { name: /job history/i })).not.toBeInTheDocument();

    fireEvent.click(toggle);
    const history = screen.getByRole("list", { name: /job history/i });
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    // The finished job is reachable from here and nowhere else in the workspace.
    expect(history).toHaveTextContent(/build a finance dashboard/i);

    fireEvent.click(toggle);
    expect(screen.queryByRole("list", { name: /job history/i })).not.toBeInTheDocument();
  });
});

describe("whether the project is at a verified state", () => {
  it("says so when HEAD is the last checkpoint", () => {
    show(
      log.opened(),
      log.committed("abc123"),
      log.at("verification.completed", { jobId: JOB, checks: [check("test", "passed")] }),
      log.at("job.checkpointed", { jobId: JOB, commitSha: "abc123" }),
    );

    expect(screen.getByRole("region", { name: /job status/i })).toHaveTextContent(
      /at a verified state/i,
    );
  });

  it("is honest about a job whose checks were all absent", () => {
    // The fold calls this `verified`, correctly — but nothing ran, and the strip is where that
    // could quietly become a claim that something did.
    show(
      log.opened(),
      log.committed("abc123"),
      log.at("verification.completed", {
        jobId: JOB,
        checks: [check("typecheck", "absent"), check("test", "absent")],
      }),
      log.at("job.checkpointed", { jobId: JOB, commitSha: "abc123" }),
    );

    const strip = screen.getByRole("region", { name: /job status/i });
    expect(strip).toHaveTextContent(/declares no checks/i);
    expect(strip).not.toHaveTextContent(/at a verified state/i);
    // The checks still appear, saying what each of them was — the sentence explains the shape,
    // and the list is the evidence for it.
    expect(screen.getByRole("list", { name: /checks/i })).toHaveTextContent(/typecheck\s*absent/);
  });

  it("says HEAD has moved past the checkpoint after an exhausted job", () => {
    show(
      log.opened(),
      log.committed("abc123"),
      log.at("job.checkpointed", { jobId: JOB, commitSha: "abc123" }),
      log.committed("def456"),
      log.at("job.completed", { jobId: JOB, outcome: "exhausted" }),
    );

    expect(screen.getByRole("region", { name: /job status/i })).toHaveTextContent(
      /ahead of the last checkpoint/i,
    );
  });
});
