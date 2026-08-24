/**
 * What the card puts on screen, queried the way somebody using a screen reader meets it.
 *
 * By role and accessible name, like the strip and the history: this is four short lines and a
 * button, and an assertion anchored to markup would pass on a version nobody can reach. The
 * card's contents are built by `unseenSummary` from real events, so what is rendered here is what
 * the rule actually produces rather than a shape it might not.
 */

import type { StoredEvent } from "@nap/shared/ports/event-store";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { check, JOB_ID as JOB, jobLog } from "../testing/job-events.ts";
import { UnseenCard } from "./unseen-card.tsx";
import { unseenSummary } from "./unseen-summary.ts";

let log = jobLog();

beforeEach(() => {
  log = jobLog();
});

function show(events: StoredEvent[], onDismiss = () => {}) {
  const card = unseenSummary(events, 0);
  if (card === null) throw new Error("the fixture concluded nothing, so there is no card to draw");

  return render(<UnseenCard card={card} onDismiss={onDismiss} />);
}

/** A job that verified after one repair, which is what the longest of these sentences describes. */
function repairedJob(): StoredEvent[] {
  return [
    log.opened(JOB, "build a todo list"),
    log.committed("abc12345678"),
    log.verified([check("typecheck", "failed", "TS2304")]),
    log.at("turn.started", { source: "verification" }),
    log.committed("def45678901"),
    log.verified([check("typecheck", "passed")]),
    log.checkpointed("def45678901"),
    log.at("job.completed", { jobId: JOB, outcome: "verified" }),
  ];
}

describe("what it says", () => {
  it("names what was asked and what became of it", () => {
    show(repairedJob());

    const card = screen.getByRole("region", { name: /while you were away/i });

    expect(card).toHaveTextContent("build a todo list");
    expect(card).toHaveTextContent(/verified/i);
    expect(card).toHaveTextContent("One repair was needed — typecheck failed, and was fixed.");
    expect(card).toHaveTextContent("def4567");
  });

  it("says nothing about repairs when none were spent", () => {
    show([
      log.opened(JOB, "build a todo list"),
      log.committed("abc12345678"),
      log.verified([check("typecheck", "passed")]),
      log.checkpointed("abc12345678"),
      log.at("job.completed", { jobId: JOB, outcome: "verified" }),
    ]);

    // Absent, not "0 repairs": the copy is singular and claims only what happened.
    expect(screen.queryByText(/repair/i)).toBeNull();
  });

  it("draws no checkpoint line for a job that reached none", () => {
    show([
      log.opened(JOB, "build a todo list"),
      log.at("job.completed", { jobId: JOB, outcome: "abandoned" }),
    ]);

    expect(screen.queryByText(/checkpoint/i)).toBeNull();
    expect(screen.getByRole("region", { name: /while you were away/i })).toHaveTextContent(
      /stopped before finishing/i,
    );
  });

  it("draws no objective line when the log cannot say what was asked", () => {
    // A turn that failed before a job could open. The card still fires; it just does not
    // invent the sentence it does not have.
    show([
      log.at("user.message", { text: "build a todo list" }),
      log.at("turn.failed", { reason: "sandbox_unavailable", message: "no capacity" }),
    ]);

    const card = screen.getByRole("region", { name: /while you were away/i });

    expect(card).toHaveTextContent("The workspace couldn't start.");
    expect(card).not.toHaveTextContent("build a todo list");
  });
});

describe("dismissing it", () => {
  it("offers one control, and it says what it does", () => {
    const onDismiss = vi.fn();
    show(repairedJob(), onDismiss);

    fireEvent.click(screen.getByRole("button", { name: /dismiss/i }));

    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
