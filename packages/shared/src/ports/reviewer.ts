/**
 * A second model that did not do the work, asked whether the work does what was asked.
 *
 * Called by the composition after a turn completes, never by the agent, so the agent can neither
 * start nor skip it. It may read and run commands and may not edit. What it says blocks only when
 * it proved it by running something; see docs/adr/0036.
 */

import type { ModelCredentials, TokenUsage } from "./llm-provider.ts";
import type { SandboxManager } from "./sandbox-manager.ts";

/** The name a review goes by among a job's checks, and in a repair prompt. */
export const REVIEW_CHECK_NAME = "review";

/**
 * Reviews one job may run. The first can send the agent back, and so can the second; after that
 * the project's checks alone arbitrate. Two, because a fix that a second review still rejects is
 * more often a reviewer and an agent disagreeing than a third repair converging.
 */
export const MAX_REVIEW_ROUNDS = 2;

/**
 * Repairs a job must have left for a review to run: one for the review to send the job back to,
 * and one more for a check that repair breaks. With fewer, a blocking review could spend the last
 * repair on work whose checks had passed, and a job that would have been published would end
 * out of repairs instead.
 */
export const REVIEW_REPAIRS_LEFT = 2;

/** Model calls one review may make: enough to read the change, run its tests and report. */
export const REVIEW_MAX_STEPS = 10;

export type ReviewFinding = {
  summary: string;
  /** The command the reviewer says shows it, exactly as it ran it. `null` for a note. */
  command: string | null;
  /** What that command printed that shows it, quoted. `null` for a note. */
  observed: string | null;
};

export type ReviewResult = {
  /** `failed` when the review itself did not finish: out of steps, a model error, cancelled. */
  status: "completed" | "failed";
  /**
   * Problems confirmed by a command the reviewer ran in this review, whose output contains what it
   * quoted. Only these send the agent back.
   */
  blocking: ReviewFinding[];
  /** Everything else it said: notes, and problems it did not confirm. Never blocks. */
  notes: ReviewFinding[];
  /** Why it did not finish, or why its report could not be read. `null` when it could. */
  failure: string | null;
  /** Model calls the review made. */
  steps: number;
  usage: TokenUsage;
};

export type ReviewRequest = {
  sandbox: SandboxManager;
  sandboxId: string;
  /** What the person, or the task, asked for. */
  objective: string;
  /** Files the agent changed, when the composition knows them. */
  changedFiles: readonly string[];
  model?: string | undefined;
  /** The turn's account: the review is billed to whoever pays for the turn. */
  credentials?: ModelCredentials | undefined;
  signal?: AbortSignal | undefined;
};

/**
 * What the reviewer is told, written in `@nap/context` and handed to the reviewer by whichever
 * composition builds it, so the product and the benchmark cannot word it differently.
 */
export type ReviewPrompts = {
  system: string;
  /** The opening message: the request, and where the work is. */
  task: (request: Pick<ReviewRequest, "objective" | "changedFiles">) => string;
};

export interface Reviewer {
  /** Reports rather than throws: a review that fails blocks nothing. */
  review(request: ReviewRequest): Promise<ReviewResult>;
}
