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
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { check, JOB_ID as JOB, jobLog } from "../testing/job-events.ts";
import { JobStrip } from "./job-strip.tsx";

let log = jobLog();

function show(...events: StoredEvent[]) {
  return render(<JobStrip events={events} />);
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
  it("is announced rather than only drawn", () => {
    // It changes while somebody is reading and nothing else on screen says so.
    show(log.opened(), log.at("verification.started", { jobId: JOB }));

    expect(screen.getByRole("status")).toHaveTextContent(/verifying/i);
  });

  it("names the state a job ends in", () => {
    show(log.opened(), log.at("job.completed", { jobId: JOB, outcome: "exhausted" }));

    expect(screen.getByRole("status")).toHaveTextContent(/out of repairs/i);
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
