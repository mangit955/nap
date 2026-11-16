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
 * The model requests and the tokens are counted here, at the provider, for one reason: a free
 * model's daily quota is counted in requests, and a benchmark run is sized by how many one task
 * takes. A `turn.failed` carries no usage, so reading it off the events would lose exactly the
 * runs that matter most.
 */

import { randomUUID } from "node:crypto";
import type { NapEvent } from "@nap/shared/events";
import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import type { AgentService } from "@nap/shared/ports/agent-service";
import type { ContextEngine } from "@nap/shared/ports/context-engine";
import type { PendingEvent } from "@nap/shared/ports/event-store";
import type { LLMProvider, LLMTurn } from "@nap/shared/ports/llm-provider";
import type { MemoryProvider } from "@nap/shared/ports/memory-provider";
import type { SandboxManager } from "@nap/shared/ports/sandbox-manager";
import { shellQuote } from "@nap/shared/shell";
import { addUsage, type TokenUsage, TokenUsageSchema } from "@nap/shared/usage";
import { z } from "zod";

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
  /** Model requests sent, retries included: what a free model's daily quota counts. */
  requests: z.int().nonnegative(),
  usage: TokenUsageSchema,
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
  /** Builds the agent on the counted provider: the count is only true if every request passes it. */
  agentFor: (provider: LLMProvider) => AgentService;
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
    `printf %s "$ws"`,
  ].join("\n");
}

/** Counts what passes through a provider: every request, and every token it reports. */
export function meterProvider(inner: LLMProvider): {
  provider: LLMProvider;
  requests(): number;
  usage(): TokenUsage;
} {
  let requests = 0;
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
            requests += 1;
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
    requests: () => requests,
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
  const agent = options.agentFor(meter.provider);
  const sessionId = randomUUID();
  const turnId = randomUUID();
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
    options.onEvent?.({ ...event, seq } as NapEvent);
  };
  const result = (workdir: string | null): TaskTurnResult => ({
    status: ending.status,
    failure: ending.status === "failed" ? { reason: ending.reason, message: ending.message } : null,
    model: options.model,
    requests: meter.requests(),
    usage: meter.usage(),
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

  emit({
    type: "user.message",
    sessionId,
    turnId,
    createdAt: new Date(clock()).toISOString(),
    payload: { text: options.instruction },
  });

  try {
    const context = await options.context.build({
      sessionId,
      sandboxId,
      userMessage: options.instruction,
      model: options.model,
      history: [],
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
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    // The agent reports what it can as `turn.failed`; this is what it could not.
    return fail("internal", error instanceof Error ? error.message : String(error), workdir);
  }
  return result(workdir);
}
