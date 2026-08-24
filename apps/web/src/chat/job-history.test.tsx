/**
 * What the history puts on screen, queried the way somebody using a screen reader meets it.
 *
 * By role and accessible name throughout, like the strip above it: this is a list of small type
 * where every row is four facts, so a markup-anchored assertion would pass on a version of it
 * nobody can reach.
 *
 * The entries are built by folding real events, so the panel is checked against what `foldJobs`
 * and `jobHistory` actually produce rather than against a shape they might not.
 */

import { foldJobs } from "@nap/shared/job-state";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { check, JOB_ID as JOB, jobLog, OTHER_JOB_ID as OTHER_JOB } from "../testing/job-events.ts";
import { jobHistory } from "./job-history.ts";
import { JobHistory } from "./job-history.tsx";

let log = jobLog();

function show(...events: StoredEvent[]) {
  return render(<JobHistory entries={jobHistory(foldJobs(events))} />);
}

/** The list itself, which every assertion here goes through. */
const list = () => screen.getByRole("list", { name: /job history/i });

/**
 * The rows, and only the rows.
 *
 * `getAllByRole("listitem")` inside the history also collects every *check* inside every row —
 * each row carries a list of its own. Filtering to direct children keeps a row count a row
 * count, rather than one that happens to be right only for jobs whose checks never ran.
 */
const rows = () =>
  within(list())
    .getAllByRole("listitem")
    .filter((row) => row.parentElement === list());

beforeEach(() => {
  log = jobLog();
});

describe("the list", () => {
  it("gives every job a row, the failed one included", () => {
    show(
      log.opened(JOB, "build a finance dashboard"),
      // Checks on the verified job, so this counts rows against a history that also has a list
      // of checks inside one of them — which is the shape a naive `listitem` count gets wrong.
      log.verified([check("typecheck", "passed"), check("test", "absent")]),
      log.checkpointed("841f4d74962d8f3078f092b8873324f176acbe0b"),
      log.at("job.completed", { jobId: JOB, outcome: "verified" }),
      log.opened(OTHER_JOB, "add a dark mode toggle"),
      log.at("job.completed", { jobId: OTHER_JOB, outcome: "abandoned" }),
    );

    const found = rows();
    expect(found).toHaveLength(2);
    // Newest first, and the one that failed is on screen rather than deleted from the record.
    expect(found[0]).toHaveTextContent(/add a dark mode toggle/i);
    expect(found[0]).toHaveTextContent(/abandoned/i);
    expect(found[1]).toHaveTextContent(/build a finance dashboard/i);
  });

  it("shows the checkpoint a verified job left, and none under a job that left none", () => {
    show(
      log.opened(JOB, "build a finance dashboard"),
      log.checkpointed("841f4d74962d8f3078f092b8873324f176acbe0b"),
      log.at("job.completed", { jobId: JOB, outcome: "verified" }),
      log.opened(OTHER_JOB, "add a dark mode toggle"),
      log.at("job.completed", { jobId: OTHER_JOB, outcome: "abandoned" }),
    );

    const found = rows();
    expect(found[1]).toHaveTextContent(/841f4d7/);
    // The session is still sitting on that sha, but this job did not make it.
    expect(found[0]).not.toHaveTextContent(/841f4d7/);
  });

  it("says what each check did, in words rather than by colour", () => {
    show(
      log.opened(JOB, "build a finance dashboard"),
      log.verified([check("typecheck", "passed"), check("test", "absent")]),
      log.at("job.completed", { jobId: JOB, outcome: "verified" }),
    );

    const checks = within(list()).getByRole("list", { name: /checks/i });
    expect(checks).toHaveTextContent(/typecheck\s*passed/);
    expect(checks).toHaveTextContent(/test\s*absent/);
  });

  it("says how many repairs a job spent and how many files it touched", () => {
    show(
      log.opened(),
      log.at("file.changed", { path: "src/App.tsx", changeType: "modified", diff: "" }),
      log.at("verification.started", { jobId: JOB }),
      log.verified([check("test", "failed")]),
      log.at("verification.started", { jobId: JOB }),
      log.verified([check("test", "failed")]),
    );

    const [row] = rows();
    expect(row).toHaveTextContent(/1 of 3 repairs used/);
    expect(row).toHaveTextContent(/1 file changed/);
  });

  it("dates each row with the full instant, not only a clock face", () => {
    // The clock reads "11:09" and says nothing about which day. The machine-readable value is
    // what keeps that from being the only answer available.
    //
    // The one query here not by role, and deliberately: `<time>` exposes none, and the element
    // *is* the semantics being asserted rather than markup standing in for them.
    show(log.opened());

    const [row] = rows();
    expect(row?.querySelector("time")).toHaveAttribute(
      "datetime",
      expect.stringMatching(/^\d{4}-/),
    );
  });

  it("numbers the rows so a job can be referred to", () => {
    show(
      log.opened(JOB),
      log.at("job.completed", { jobId: JOB, outcome: "verified" }),
      log.opened(OTHER_JOB),
    );

    const found = rows();
    expect(found[0]).toHaveTextContent(/job 2/i);
    expect(found[1]).toHaveTextContent(/job 1/i);
  });

  it("draws nothing at all when there is no history", () => {
    show();

    expect(screen.queryByRole("list", { name: /job history/i })).not.toBeInTheDocument();
  });
});
