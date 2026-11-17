/**
 * A review's result in the two shapes a job already knows: a check, and the failure a repair is
 * prompted from (ADR-0036 D4), and the product job's review round itself.
 *
 * Both compositions read the shapes from here, the product's job and the Terminal-Bench turn, so
 * the findings the agent is sent back with are rendered the same way in each.
 */

import { checkedOutBranch, discardUncommitted, workspaceState } from "@nap/sandbox/git";
import type { NapEvent, VerifiedCheck } from "@nap/shared/events";
import { getLogger } from "@nap/shared/logging";
import type { ModelCredentials } from "@nap/shared/ports/llm-provider";
import {
  MAX_REVIEW_ROUNDS,
  REVIEW_CHECK_NAME,
  type Reviewer,
  type ReviewFinding,
  type ReviewResult,
} from "@nap/shared/ports/reviewer";
import type { SandboxManager } from "@nap/shared/ports/sandbox-manager";
import type { CheckFailure } from "./verify-turn.ts";

export type JobReviewRequest = {
  reviewer: Reviewer;
  sandbox: SandboxManager;
  sandboxId: string;
  /** The commit the checks just passed, which the workspace is put back to afterwards. */
  commitSha: string;
  jobId: string;
  /** The session's log, which says how many reviews this job has had and what it changed. */
  history: readonly NapEvent[];
  objective: string;
  model: string | undefined;
  credentials: ModelCredentials | undefined;
  signal: AbortSignal | undefined;
};

/**
 * One review of a product job, as a check, or `null` when there is none to record.
 *
 * `null` when the job has had its `MAX_REVIEW_ROUNDS`, counted from the log so a restart cannot
 * reset the count, and when the review throws or the workspace cannot be put back: a review that
 * did not happen cleanly blocks nothing, and the job goes on as its checks decided.
 *
 * The workspace is put back to the checked commit if the review changed it. The reviewer has no
 * tool that writes, but a command it runs can (ADR-0036 D2), and nothing it left may reach the
 * next turn or the pull request.
 */
export async function reviewJob(
  request: JobReviewRequest,
): Promise<ReturnType<typeof reviewCheck> | null> {
  const { sandbox, sandboxId, commitSha, jobId, history } = request;
  if (reviewRounds(history, jobId) >= MAX_REVIEW_ROUNDS) return null;
  try {
    const branch = await checkedOutBranch(sandbox, sandboxId);
    const before = await workspaceState(sandbox, sandboxId);
    const result = await request.reviewer.review({
      sandbox,
      sandboxId,
      objective: request.objective,
      changedFiles: changedFilesOf(history, jobId),
      model: request.model,
      credentials: request.credentials,
      signal: request.signal,
    });
    getLogger().info(
      {
        commitSha,
        status: result.status,
        blocking: result.blocking.length,
        notes: result.notes.length,
        steps: result.steps,
        usage: result.usage,
      },
      "reviewed the job",
    );
    const after = await workspaceState(sandbox, sandboxId);
    const branchAfter = await checkedOutBranch(sandbox, sandboxId);
    const unchanged =
      branch.ok &&
      branchAfter.ok &&
      branch.value === branchAfter.value &&
      before.ok &&
      after.ok &&
      before.value === after.value;
    // Without the branch it was on, nothing can be put back safely: the review blocks nothing.
    if (!branch.ok) return null;
    const reset = unchanged
      ? null
      : await discardUncommitted(sandbox, sandboxId, { sha: commitSha, branch: branch.value });
    if (reset !== null && !reset.ok) {
      getLogger().warn({ err: reset.error }, "could not reset the workspace after the review");
      return null;
    }
    return reviewCheck(result);
  } catch (error) {
    getLogger().warn({ err: error }, "the review could not be run");
    return null;
  }
}

/** Reviews the job has had, read from its `verification.completed` events. */
export function reviewRounds(history: readonly NapEvent[], jobId: string): number {
  return history.filter(
    (event) =>
      event.type === "verification.completed" &&
      event.payload.jobId === jobId &&
      event.payload.checks.some((check) => check.name === REVIEW_CHECK_NAME),
  ).length;
}

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
