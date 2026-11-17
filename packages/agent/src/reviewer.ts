/**
 * The reviewer: a short model loop with a fresh conversation, asked whether finished work does
 * what was asked (ADR-0036).
 *
 * Not a helper, though it borrows a helper's parts. A helper is a tool the agent chooses to call
 * inside its turn's budget, and its tool calls are hidden from everything but its report. The
 * reviewer is a gate the composition calls after the turn has ended, and it keeps exactly what a
 * helper throws away: every command it ran and what that command printed, because that record is
 * what decides whether a finding may block.
 *
 * **Only a finding it proved can block.** The model reports problems with the command that shows
 * each and a quote of its output. A problem blocks when that command is one this review ran and
 * its output contains the quote; the check is here, in code, against the record. Everything else
 * is a note. A review that fails, or a report that cannot be read, blocks nothing.
 */

import type { LLMContentBlock, LLMMessage, LLMProvider } from "@nap/shared/ports/llm-provider";
import {
  REVIEW_MAX_STEPS,
  type Reviewer,
  type ReviewFinding,
  type ReviewRequest,
  type ReviewResult,
} from "@nap/shared/ports/reviewer";
import { addUsage, type TokenUsage } from "@nap/shared/usage";
import { z } from "zod";
import { CANCELLED, stopAware } from "./cancellation.ts";
import { appendText } from "./subagents.ts";
import { REVIEW_TOOL_NAMES, TOOL_DEFINITIONS } from "./tools/definitions.ts";
import { executeTool } from "./tools/execute.ts";
import { FileLedger } from "./tools/ledger.ts";

/** Output tokens one review request may use: a report, or a few tool calls, never a file. */
const REVIEW_MAX_OUTPUT_TOKENS = 4_096;

/** A quote shorter than this proves nothing: "ok" or "1" appears in almost any output. */
const MIN_QUOTE_CHARS = 4;

/** How much of an unreadable report is kept as a note. */
const UNREADABLE_REPORT_CHARS = 2_000;

/** What `run_command` prints first when the command actually ran, as against being refused. */
const RAN = /^exit code -?\d+/;

const LAST_REQUEST =
  "This is your last request. Reply now with your JSON report, from what you have found.";

/**
 * The report as the model writes it. Not strict: a model that adds a field has still answered,
 * and the fields that matter are checked against the record anyway.
 */
const ReviewReportSchema = z.object({
  problems: z
    .array(
      z.object({
        summary: z.string().min(1),
        command: z.string().nullish(),
        observed: z.string().nullish(),
      }),
    )
    .default([]),
  notes: z.array(z.union([z.string(), z.object({ summary: z.string() })])).default([]),
});

export type NapReviewerOptions = {
  provider: LLMProvider;
  /** From `@nap/context/review-prompt`: prompts belong to the context package. */
  systemPrompt: string;
  maxSteps?: number;
  now?: () => string;
};

export class NapReviewer implements Reviewer {
  readonly #options: NapReviewerOptions;

  constructor(options: NapReviewerOptions) {
    this.#options = options;
  }

  async review(request: ReviewRequest): Promise<ReviewResult> {
    const { provider, systemPrompt } = this.#options;
    const maxSteps = this.#options.maxSteps ?? REVIEW_MAX_STEPS;
    const now = this.#options.now ?? (() => new Date().toISOString());
    const { signal } = request;
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let steps = 0;
    /** Every command that ran, with everything it printed each time it ran. */
    const ran = new Map<string, string[]>();
    const failed = (failure: string): ReviewResult => ({
      status: "failed",
      blocking: [],
      notes: [],
      failure,
      steps,
      usage,
    });

    const turn = provider.startTurn({ model: request.model, credentials: request.credentials });
    const tools = TOOL_DEFINITIONS.filter((tool) => REVIEW_TOOL_NAMES.includes(tool.name));
    const offered = new Set(REVIEW_TOOL_NAMES);
    const ledger = new FileLedger();
    const messages: LLMMessage[] = [{ role: "user", content: reviewTask(request) }];

    try {
      for (let step = 1; step <= maxSteps; step += 1) {
        if (signal?.aborted) return failed("Cancelled before it finished.");
        if (step === maxSteps) appendText(messages, LAST_REQUEST);
        const completed = await stopAware(
          turn.complete({
            systemPrompt,
            messages: [...messages],
            tools,
            maxOutputTokens: REVIEW_MAX_OUTPUT_TOKENS,
            ...(signal === undefined ? {} : { signal }),
          }),
          signal,
        );
        if (completed === CANCELLED) return failed("Cancelled before it finished.");
        steps += 1;
        usage = addUsage(usage, completed.usage);
        if (completed.type === "refusal") return failed("The model declined to review.");
        if (completed.type === "error") return failed(completed.message);
        if (completed.toolCalls.length === 0)
          return { ...judge(completed.text, ran), steps, usage };

        const results: LLMContentBlock[] = [];
        for (const call of completed.toolCalls) {
          if (signal?.aborted) return failed("Cancelled before it finished.");
          const outcome = await executeTool(call, {
            sessionId: "review",
            turnId: "review",
            sandboxId: request.sandboxId,
            sandbox: request.sandbox,
            signal,
            offered,
            ledger,
            backgroundShells: false,
            // The review's traffic is its own; nothing it does belongs in the turn's log.
            emit: () => {},
            now,
          });
          const command = commandOf(call.name, call.input);
          if (command !== null && RAN.test(outcome.output)) {
            ran.set(command, [...(ran.get(command) ?? []), outcome.output]);
          }
          results.push({
            type: "tool_result",
            toolCallId: call.id,
            content: outcome.output,
            isError: !outcome.ok,
          });
        }
        const assistant: LLMContentBlock[] = completed.toolCalls.map((call) => ({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input: call.input,
        }));
        if (completed.text !== "") assistant.unshift({ type: "text", text: completed.text });
        messages.push(
          { role: "assistant", content: assistant },
          { role: "user", content: results },
        );
      }
      return failed("Ran out of steps before reporting.");
    } catch (error) {
      return failed(error instanceof Error ? error.message : String(error));
    }
  }
}

/** The review's opening message: the request, and where the work is. */
export function reviewTask(request: Pick<ReviewRequest, "objective" | "changedFiles">): string {
  const files =
    request.changedFiles.length === 0
      ? "The agent's changes are in the project; look at it as it is now."
      : `Files the agent changed:\n${request.changedFiles.map((path) => `- ${path}`).join("\n")}`;
  return `The request the agent was given:\n\n<request>\n${request.objective}\n</request>\n\n${files}`;
}

/**
 * Reads the report and decides which problems were proved.
 *
 * Exported for its tests: this is the rule that keeps an invented problem from sending the agent
 * back, so it is tested directly rather than only through a scripted model.
 */
export function judge(
  text: string,
  ran: ReadonlyMap<string, readonly string[]>,
): Pick<ReviewResult, "status" | "blocking" | "notes" | "failure"> {
  const report = parseReport(text);
  if (report === null)
    return {
      status: "completed",
      blocking: [],
      notes:
        text.trim() === ""
          ? []
          : [
              {
                summary: text.trim().slice(0, UNREADABLE_REPORT_CHARS),
                command: null,
                observed: null,
              },
            ],
      failure: "The reviewer's report could not be read, so nothing it said can block.",
    };

  const blocking: ReviewFinding[] = [];
  const notes: ReviewFinding[] = report.notes.map((note) => ({
    summary: typeof note === "string" ? note : note.summary,
    command: null,
    observed: null,
  }));
  for (const problem of report.problems) {
    const finding: ReviewFinding = {
      summary: problem.summary,
      command: problem.command ?? null,
      observed: problem.observed ?? null,
    };
    if (proved(finding, ran)) blocking.push(finding);
    else notes.push(finding);
  }
  return { status: "completed", blocking, notes, failure: null };
}

/** Its command ran in this review, and printed what it quotes. */
function proved(finding: ReviewFinding, ran: ReadonlyMap<string, readonly string[]>): boolean {
  if (finding.command === null || finding.observed === null) return false;
  const quote = squash(finding.observed);
  if (quote.length < MIN_QUOTE_CHARS) return false;
  const outputs = ran.get(finding.command.trim()) ?? [];
  return outputs.some((output) => squash(output).includes(quote));
}

/** Whitespace differences are how a model copies output, not a sign it invented it. */
function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function commandOf(name: string, input: unknown): string | null {
  if (name !== "run_command" || typeof input !== "object" || input === null) return null;
  const command = (input as { command?: unknown }).command;
  return typeof command === "string" ? command.trim() : null;
}

/** The last JSON object in the reply, fenced or bare. */
function parseReport(text: string): z.infer<typeof ReviewReportSchema> | null {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((match) => match[1]);
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const candidates = [...fenced.reverse(), start === -1 ? undefined : text.slice(start, end + 1)];
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    try {
      const parsed = ReviewReportSchema.safeParse(JSON.parse(candidate));
      if (parsed.success) return parsed.data;
    } catch {
      // Not JSON; the next candidate may be.
    }
  }
  return null;
}
