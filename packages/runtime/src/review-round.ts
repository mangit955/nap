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
import type { TokenUsage } from "@nap/shared/usage";
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
 * What one review of a product job came to: the check to record, and what it cost.
 *
 * Kept apart because a review can cost tokens and still have no check to record, and the person
 * is billed for those tokens either way.
 */
export type JobReview = {
  /**
   * `null` when the job has had its `MAX_REVIEW_ROUNDS`, counted from the log so a restart cannot
   * reset the count, and when the review throws or the workspace cannot be put back: a review that
   * did not happen cleanly blocks nothing, and the job goes on as its checks decided.
   */
  verdict: ReturnType<typeof reviewCheck> | null;
  /** `null` when no review ran, or one threw and so reported nothing. */
  usage: TokenUsage | null;
};

const NO_REVIEW: JobReview = { verdict: null, usage: null };

/**
 * One review of a product job.
 *
 * The workspace is put back to the checked commit if the review changed it. The reviewer has no
 * tool that writes, but a command it runs can (ADR-0036 D2), and nothing it left may reach the
 * next turn or the pull request.
 */
export async function reviewJob(request: JobReviewRequest): Promise<JobReview> {
  if (reviewRounds(request.history, request.jobId) >= MAX_REVIEW_ROUNDS) return NO_REVIEW;
  // The ports report rather than throw, but the job's checks have already passed by now, and a
  // review must never turn that into a failed turn.
  try {
    return await reviewAndPutBack(request);
  } catch (error) {
    getLogger().warn({ err: error }, "the review could not be run");
    return NO_REVIEW;
  }
}

async function reviewAndPutBack(request: JobReviewRequest): Promise<JobReview> {
  const { sandbox, sandboxId, commitSha, jobId, history } = request;
  // Read before anything is spent: without the branch, nothing a review's commands changed could
  // be put back safely, so there is no review.
  const branch = await checkedOutBranch(sandbox, sandboxId);
  if (!branch.ok) return NO_REVIEW;
  const before = await workspaceState(sandbox, sandboxId);
  let result: ReviewResult | null = null;
  try {
    result = await request.reviewer.review({
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
  } catch (error) {
    getLogger().warn({ err: error }, "the review could not be run");
  }
  // Whether or not the review finished: its commands may have run either way.
  const after = await workspaceState(sandbox, sandboxId);
  const branchAfter = await checkedOutBranch(sandbox, sandboxId);
  const unchanged =
    branchAfter.ok &&
    branch.value === branchAfter.value &&
    before.ok &&
    after.ok &&
    before.value === after.value;
  if (!unchanged) {
    const reset = await discardUncommitted(sandbox, sandboxId, {
      sha: commitSha,
      branch: branch.value,
    });
    if (!reset.ok) {
      getLogger().warn({ err: reset.error }, "could not reset the workspace after the review");
      return { verdict: null, usage: result?.usage ?? null };
    }
  }
  return result === null ? NO_REVIEW : { verdict: reviewCheck(result), usage: result.usage };
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
