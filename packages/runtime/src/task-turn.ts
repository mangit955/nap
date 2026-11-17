/**
 * One turn of Nap's agent on a benchmark task, in a machine Nap did not build.
 *
 * `SingleAgentRuntime` is a Nap turn: it acquires a sandbox, serves a preview, verifies the
 * project's checks, commits, snapshots and photographs the result. Every one of those is wrong
 * for a Terminal-Bench task, whose machine belongs to the harness and whose result is judged by
 * the harness's own hidden tests after the turn. What is left is the smallest composition that is
 * still Nap's agent: the context engine assembles the prompt, the agent service runs the loop and
 * its tools against the sandbox, and nothing else happens. See ADR-0035.
 *
 * **A reviewer, when one is composed, is the product's** (ADR-0036): after the agent claims done,
 * `NapReviewer` checks the work, and a problem it proved sends the agent back, as in an imported
 * repository's job. Two things differ from the product, both about the budget: the agent's steps
 * are capped across the whole task, so a fix round gets only what the first turn left, and the
 * reviewer's steps and tokens are metered apart from the agent's. A score measured with the
 * reviewer then cannot owe anything to the agent getting more steps than the baseline did. What a
 * review's commands wrote is put back afterwards, as the product resets to its commit
 * (`task-review-guard.ts`), so a review does not change the answer by itself, within the limits
 * that file states.
 *
 * Model calls and tokens are counted here, at the provider, and HTTP requests by whoever built the
 * client, for one reason: a free model's daily quota is counted in requests, and a benchmark run
 * is sized by how many one task takes. A `turn.failed` carries no usage, so reading it off the
 * events would lose exactly the runs that matter most.
 */

import { randomUUID } from "node:crypto";
import type { NapEvent } from "@nap/shared/events";
import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import type { AgentService } from "@nap/shared/ports/agent-service";
import type { ContextEngine, FailedAttempt } from "@nap/shared/ports/context-engine";
import type { PendingEvent } from "@nap/shared/ports/event-store";
import type { LLMProvider, LLMTurn } from "@nap/shared/ports/llm-provider";
import type { MemoryProvider } from "@nap/shared/ports/memory-provider";
import { MAX_REVIEW_ROUNDS, type Reviewer } from "@nap/shared/ports/reviewer";
import type { SandboxManager } from "@nap/shared/ports/sandbox-manager";
import { shellQuote } from "@nap/shared/shell";
import { addUsage, type TokenUsage, TokenUsageSchema } from "@nap/shared/usage";
import { z } from "zod";
import { repairPrompt } from "./repair-prompt.ts";
import { changedFilesOf, renderFinding, reviewCheck } from "./review-round.ts";
import { afterReview, beforeReview } from "./task-review-guard.ts";

/** How much of each finding a result keeps. */
const FINDING_CHARS = 1_000;

/** One review of the task, as the report reads it. */
export const TaskReviewSchema = z.strictObject({
  status: z.enum(["completed", "failed"]),
  /** Problems it proved, which sent the agent back if it had steps left. */
  blocking: z.int().nonnegative(),
  notes: z.int().nonnegative(),
  failure: z.string().nullable(),
  steps: z.int().nonnegative(),
  usage: TokenUsageSchema,
  /** Whether the agent was sent back on it. */
  sentBack: z.boolean(),
  /**
   * What it said, rendered as a person reads it: the problems it proved first, then its notes,
   * each cut to `FINDING_CHARS`. Kept so a run's reviews can be read without its trajectory.
   */
  findings: z.array(z.string()),
  /**
   * Files in the task's directory written while the review ran, up to `WROTE_LIMIT`; `null` when
   * that could not be read. See `task-review-guard.ts`.
   */
  wrote: z.array(z.string()).nullable(),
  /**
   * Whether the files listed were put back as they were before the review. False when the
   * directory was too large to copy, or the copy failed: then a review's writes stayed, and a
   * report shows the trial as one the review itself could have changed. It covers only what the
   * guard can see; `task-review-guard.ts` names what it cannot.
   */
  restored: z.boolean(),
});
export type TaskReview = z.infer<typeof TaskReviewSchema>;

/**
 * What a trial leaves for the harness to read: the outcome and Nap's own accounting.
 *
 * Read by `harbor/nap_harbor/trial.py`, which is Python and cannot import this. Both sides read
 * `harbor/nap_harbor/result-example.json`, so a field renamed here fails a test on each side.
 */
export const TaskTurnResultSchema = z.strictObject({
  status: z.enum(["completed", "failed"]),
  /** Why it failed, as the turn said. `null` when it completed. */
  failure: z.strictObject({ reason: z.string(), message: z.string() }).nullable(),
  model: z.string().min(1),
  /**
   * HTTP requests sent to the model, every retry included: what a free model's daily quota
   * counts. At least `steps` plus every review's steps, more when the provider retried a
   * throttled or failed request: the agent and the reviewer share one counted client.
   */
  requests: z.int().nonnegative(),
  /** Model calls the agent made, across every round: its steps. The reviewer's are not here. */
  steps: z.int().nonnegative(),
  /** Every token the trial spent: the agent's, and the reviewer's when there was one. */
  usage: TokenUsageSchema,
  /**
   * Each review, in order. Absent when no reviewer was composed, which is every result written
   * before there was one; empty when one was, but the agent never claimed done.
   */
  reviews: z.array(TaskReviewSchema).optional(),
  durationMs: z.int().nonnegative(),
  /** The task's own directory, which the agent's project path was linked to. */
  workdir: z.string().nullable(),
});
export type TaskTurnResult = z.infer<typeof TaskTurnResultSchema>;

export type TaskTurnOptions = {
  sandbox: SandboxManager;
  context: ContextEngine;
  memory: MemoryProvider;
  /** The provider the turn runs on, before it is counted. */
  provider: LLMProvider;
  /**
   * Builds the agent on the counted provider, with the steps it has left: the count is only true if
   * every request passes it, and the cap is only the baseline's if every round shares it.
   */
  agentFor: (provider: LLMProvider, maxSteps: number) => AgentService;
  /** The agent's steps for the whole task, fix rounds included. */
  maxSteps: number;
  /** Builds the reviewer on its own counted provider. Absent, the agent's claim stands alone. */
  reviewerFor?: (provider: LLMProvider) => Reviewer;
  /**
   * HTTP requests sent so far, counted by whoever built the provider's client: the provider
   * retries below `complete()`, where nothing here can see it. See `@nap/agent/counted-client`.
   */
  requests: () => number;
  instruction: string;
  model: string;
  /** Every event, numbered in the order it happened. */
  onEvent?: (event: NapEvent) => void;
  signal?: AbortSignal;
  clock?: () => number;
};

/**
 * Points the agent's project path at the task's working directory.
 *
 * The agent's tools, its command guard and its prompt all name `/home/user/app`, a constant across
 * the agent package, and a task names its own directory, usually `/app`. A link reconciles them
 * without teaching every tool a second root: both paths are one directory, and the hidden tests
 * see the agent's files where they expect them. A machine whose working directory is `/` has no
 * project to link, and linking the whole filesystem would make every path look like the project.
 */
export function linkWorkspaceCommand(): string {
  const root = shellQuote(PROJECT_ROOT_PATH);
  return [
    `ws=$(pwd -P)`,
    `if [ "$ws" = / ]; then echo "the task's working directory is /, which is not a project" >&2; exit 1; fi`,
    `if [ ! -e ${root} ]; then mkdir -p "$(dirname ${root})" && ln -s "$ws" ${root}; fi`,
    // Checked rather than assumed: a machine that already has something at the project path, or
    // a link that could not be made, would leave the agent working where the tests never look.
    `if [ "$(cd ${root} 2>/dev/null && pwd -P)" != "$ws" ]; then echo "${PROJECT_ROOT_PATH} is not the task's working directory $ws" >&2; exit 1; fi`,
    `printf %s "$ws"`,
  ].join("\n");
}

/** Counts what passes through a provider: every model call, and every token it reports. */
export function meterProvider(inner: LLMProvider): {
  provider: LLMProvider;
  steps(): number;
  usage(): TokenUsage;
} {
  let steps = 0;
  const turns: LLMTurn[] = [];
  return {
    provider: {
      startTurn(options) {
        const turn = inner.startTurn(options);
        turns.push(turn);
        // Every other member of the turn passes through, so the agent sees the provider it was
        // built for; only `complete` is counted. Methods are called on the real turn, whose
        // private state a copy or a prototype would not reach.
        const compact = turn.compact;
        return {
          complete: (request) => {
            steps += 1;
            return turn.complete(request);
          },
          usage: () => turn.usage(),
          ...(compact === undefined ? {} : { compact: (request) => compact.call(turn, request) }),
          ...(turn.contextWindowTokens === undefined
            ? {}
            : { contextWindowTokens: turn.contextWindowTokens }),
          ...(turn.billedWeights === undefined ? {} : { billedWeights: turn.billedWeights }),
        };
      },
    },
    steps: () => steps,
    usage: () =>
      turns.reduce((total, turn) => addUsage(total, turn.usage()), {
        inputTokens: 0,
        outputTokens: 0,
      }),
  };
}

export async function runTaskTurn(options: TaskTurnOptions): Promise<TaskTurnResult> {
  const clock = options.clock ?? Date.now;
  const started = clock();
  const meter = meterProvider(options.provider);
  const reviewMeter = meterProvider(options.provider);
  const reviewer = options.reviewerFor?.(reviewMeter.provider);
  const reviews: TaskReview[] = [];
  const sessionId = randomUUID();
  const events: NapEvent[] = [];
  let seq = 0;
  let ending: { status: "completed" } | { status: "failed"; reason: string; message: string } = {
    status: "failed",
    reason: "internal",
    message: "The turn ended without saying how.",
  };
  const emit = (event: PendingEvent) => {
    seq += 1;
    if (event.type === "turn.completed") ending = { status: "completed" };
    if (event.type === "turn.failed")
      ending = { status: "failed", reason: event.payload.reason, message: event.payload.message };
    const numbered = { ...event, seq } as NapEvent;
    events.push(numbered);
    options.onEvent?.(numbered);
  };
  const result = (workdir: string | null): TaskTurnResult => ({
    status: ending.status,
    failure: ending.status === "failed" ? { reason: ending.reason, message: ending.message } : null,
    model: options.model,
    requests: options.requests(),
    steps: meter.steps(),
    usage: addUsage(meter.usage(), reviewMeter.usage()),
    ...(reviewer === undefined ? {} : { reviews }),
    durationMs: Math.max(0, Math.round(clock() - started)),
    workdir,
  });
  const fail = (reason: string, message: string, workdir: string | null) => {
    ending = { status: "failed", reason, message };
    return result(workdir);
  };

  const created = await options.sandbox.create("harbor-task");
  if (!created.ok) return fail("sandbox_unavailable", created.error.message, null);
  const sandboxId = created.value.id;

  const linked = await options.sandbox.exec(sandboxId, linkWorkspaceCommand());
  if (!linked.ok) return fail("sandbox_unavailable", linked.error.message, null);
  if (linked.value.exitCode !== 0)
    return fail("sandbox_unavailable", linked.value.stderr.trim(), null);
  const workdir = linked.value.stdout;

  // A round is a turn: the task's own, then one per review that sent the agent back, each with
  // the conversation so far, as a repair turn has its session's (ADR-0006).
  const attempts: FailedAttempt[] = [];
  let prompt = options.instruction;
  // A function, because `ending` is assigned inside `emit` where the compiler cannot follow it.
  const claimedDone = () => ending.status === "completed";
  for (;;) {
    const history = [...events];
    const turnId = randomUUID();
    const agent = options.agentFor(meter.provider, options.maxSteps - meter.steps());
    emit({
      type: "user.message",
      sessionId,
      turnId,
      createdAt: new Date(clock()).toISOString(),
      payload: { text: prompt },
    });
    try {
      const context = await options.context.build({
        sessionId,
        sandboxId,
        userMessage: prompt,
        model: options.model,
        history,
        ...(attempts.length === 0
          ? {}
          : { job: { objective: options.instruction, attempts: [...attempts] } }),
        sandbox: options.sandbox,
        memory: options.memory,
        workspace: "task",
      });
      await agent.runTurn({
        sessionId,
        turnId,
        sandboxId,
        context,
        sandbox: options.sandbox,
        model: options.model,
        onEvent: emit,
        ...(attempts.length === 0 ? {} : { promptSource: "verification" as const }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      // The agent reports what it can as `turn.failed`; this is what it could not.
      return fail("internal", error instanceof Error ? error.message : String(error), workdir);
    }

    // Reviewed only when the agent claimed done and a fix could follow: as in the product, a
    // review can only send the agent back, never take a claim away by itself.
    if (
      reviewer === undefined ||
      !claimedDone() ||
      reviews.length >= MAX_REVIEW_ROUNDS ||
      meter.steps() >= options.maxSteps ||
      options.signal?.aborted === true
    )
      break;
    const guard = await beforeReview(options.sandbox, sandboxId);
    const review = await reviewer.review({
      sandbox: options.sandbox,
      sandboxId,
      objective: options.instruction,
      changedFiles: changedFilesOf(events),
      model: options.model,
      signal: options.signal,
    });
    const { failure } = reviewCheck(review);
    const { wrote, restored } = await afterReview(options.sandbox, sandboxId, guard);
    reviews.push({
      status: review.status,
      blocking: review.blocking.length,
      notes: review.notes.length,
      failure: review.failure,
      steps: review.steps,
      usage: review.usage,
      sentBack: failure !== null,
      findings: [...review.blocking, ...review.notes].map((finding) =>
        renderFinding(finding).slice(0, FINDING_CHARS),
      ),
      wrote,
      restored,
    });
    if (failure === null) break;
    attempts.push({ check: failure.name, detail: failure.detail, output: failure.output });
    prompt = repairPrompt({ failed: failure, attempt: reviews.length, of: MAX_REVIEW_ROUNDS });
  }
  return result(workdir);
}
