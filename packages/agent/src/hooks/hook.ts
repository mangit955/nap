/**
 * The seams in a turn's loop that behaviour can attach to without the loop knowing about it.
 *
 * Without them every rule about *when* the model is told something — a reminder, a project's
 * rules for the directory it just opened, a refusal to stop while a helper is still running —
 * becomes another branch in the loop, and the loop is the one piece of this package whose
 * invariants (one terminal event, results returned together, nothing persisted) every other
 * piece leans on. A hook can add words and can delay the end; it cannot emit a terminal event,
 * persist anything or reorder a batch, because none of those are on this interface.
 *
 * Four seams, each with a user today (ADR-0020). Hooks run in the order they were given, and
 * each sees the outcome the one before it produced.
 */

import type { LLMToolCall } from "@nap/shared/ports/llm-provider";
import type { ToolOutcome } from "../tools/context.ts";

export interface TurnHook {
  /**
   * Something the model should be reminded of before its next request, or nothing.
   *
   * Reminders are appended to the conversation's last user message rather than sent as a new
   * one, so they never split a tool result from the request it answers, and they ride after the
   * cached prefix rather than inside it.
   */
  beforeModel?(step: number): string | undefined;
  /** May add to what a tool told the model; may not turn a failure into a success. */
  afterTool?(call: LLMToolCall, outcome: ToolOutcome): Promise<ToolOutcome>;
  /**
   * Why the turn should not end yet, or nothing. The model gets the reason and another step;
   * the loop consults stop hooks a bounded number of times, so a hook cannot keep a turn alive.
   */
  beforeStop?(): Promise<string | undefined>;
  /** The working conversation was replaced by a summary, taking anything a hook added with it. */
  compacted?(): void;
}
