/**
 * A review's result in the two shapes a job already knows: a check, and the failure a repair is
 * prompted from (ADR-0036 D4).
 *
 * Both compositions read it from here, the product's job and the Terminal-Bench turn, so the
 * words the agent is sent back with are the same in each.
 */

import type { NapEvent, VerifiedCheck } from "@nap/shared/events";
import {
  REVIEW_CHECK_NAME,
  type ReviewFinding,
  type ReviewResult,
} from "@nap/shared/ports/reviewer";
import type { CheckFailure } from "./verify-turn.ts";

/** The review as a check, and, when it found something it proved, the failure to repair. */
export function reviewCheck(result: ReviewResult): {
  check: VerifiedCheck;
  failure: CheckFailure | null;
} {
  const notes = [
    ...(result.failure === null ? [] : [`The review did not finish cleanly: ${result.failure}`]),
    ...result.notes.map(renderFinding),
  ];
  if (result.blocking.length === 0)
    return {
      check: {
        name: REVIEW_CHECK_NAME,
        outcome: "passed",
        output: notes.length === 0 ? null : notes.join("\n\n"),
      },
      failure: null,
    };

  const output = result.blocking.map(renderFinding).join("\n\n");
  const count = result.blocking.length;
  return {
    check: { name: REVIEW_CHECK_NAME, outcome: "failed", output },
    failure: {
      name: REVIEW_CHECK_NAME,
      detail: `${count} ${count === 1 ? "problem" : "problems"} shown by commands the reviewer ran`,
      output,
    },
  };
}

/** One finding as a person, or the agent, reads it: what is wrong, and the evidence. */
export function renderFinding(finding: ReviewFinding): string {
  if (finding.command === null) return `- ${finding.summary}`;
  return [
    `- ${finding.summary}`,
    `  \`${finding.command}\` printed:`,
    ...(finding.observed ?? "").split("\n").map((line) => `    ${line}`),
  ].join("\n");
}

/**
 * The files the agent changed, oldest first, once each: what the reviewer is pointed at.
 *
 * With a `jobId`, only those changed since that job opened, across all of its turns, because a
 * repair's review is of the job's work, not of the repair alone.
 */
export function changedFilesOf(events: readonly NapEvent[], jobId?: string): string[] {
  const start =
    jobId === undefined
      ? 0
      : events.findIndex((event) => event.type === "job.started" && event.payload.jobId === jobId);
  const files = new Set<string>();
  for (const event of events.slice(Math.max(start, 0)))
    if (event.type === "file.changed") files.add(event.payload.path);
  return [...files];
}
