/**
 * Assembles everything the model sees for one turn, and owns what it costs.
 *
 * Two jobs, and only these two. It decides *what* goes in the prompt, and it guarantees the
 * result fits a token budget. It never calls the model, never decides a turn is over, and
 * never touches the workspace beyond listing it.
 *
 * The budget is the part worth being careful about. Every turn ships a system prompt, a file
 * listing, retrieved memories and a slice of the conversation, and the conversation is the
 * part that grows without limit — a long session's tool output alone will outgrow any
 * context window. Something has to be dropped, and *what* gets dropped is the difference
 * between an agent that remembers what it was asked and one that quietly forgets. So the
 * order below is fixed, written down, and tested; it is not an implementation detail.
 *
 * The one thing that is never dropped is the system prompt. An agent that has forgotten which
 * framework it is writing against produces confidently wrong code, which is worse than an
 * agent that has forgotten the conversation and asks.
 */

import type { NapEvent } from "@nap/shared/events";
import type { BuiltContext, ContextEngine, ContextRequest } from "@nap/shared/ports/context-engine";
import type { LLMContentBlock, LLMMessage } from "@nap/shared/ports/llm-provider";
import type { Memory } from "@nap/shared/ports/memory-provider";
import { buildFileTreeDigest } from "./file-tree.ts";
import { SYSTEM_PROMPT } from "./system-prompt.ts";
import { estimateTokens } from "./tokens.ts";

/**
 * What a turn is allowed to spend on input.
 *
 * Far below the model's context window, deliberately. The window is a capacity limit; this
 * is a cost limit, and they are not the same number. Filling a million-token window on every
 * turn of every session costs real money and buys nothing — the model does not answer a
 * front-end question better for having been handed the whole project. Raise it when a real
 * turn is observed running out of room, not because the window is bigger.
 */
export const DEFAULT_BUDGET_TOKENS = 120_000;

/** Marks output removed to fit the budget, so the model reads a gap rather than a fact. */
export const ELIDED_TOOL_OUTPUT = "[output removed to fit the context budget]";

/** Room for the turn's own message once the contract is paid for. */
const USER_MESSAGE_FLOOR_TOKENS = 256;

/**
 * The smallest budget that can produce anything worth sending. Derived rather than written
 * down, so editing the contract can never leave a stale floor behind it.
 */
export const MIN_BUDGET_TOKENS = estimateTokens(SYSTEM_PROMPT) + USER_MESSAGE_FLOOR_TOKENS;

const DEFAULT_MAX_TURNS = 20;

export type NapContextEngineOptions = {
  budgetTokens?: number;
  /** How many past turns may appear before truncation is even considered. */
  maxTurns?: number;
  root?: string;
  maxFileEntries?: number;
};

/** A past turn, kept whole so a tool call and its answer can only leave together. */
type Turn = {
  id: string;
  messages: LLMMessage[];
};

function textBlock(text: string): LLMContentBlock {
  return { type: "text", text };
}

/**
 * Maps the event log onto a conversation.
 *
 * Only four event types are things somebody said. The rest — summarized reasoning, file
 * diffs, command output, preview URLs, notices, turn lifecycle — exist so the client can
 * render progress. Replaying `agent.thinking` as an assistant message would be the
 * damaging one: it is a summary produced *about* the model's reasoning, and feeding it back
 * as the model's own words invents a turn that never happened.
 */
function toMessages(events: NapEvent[]): LLMMessage[] {
  const messages: LLMMessage[] = [];

  const push = (role: LLMMessage["role"], block: LLMContentBlock): void => {
    const last = messages.at(-1);
    // Coalesce, so parallel tool calls stay in one assistant turn and their answers in the
    // single user turn that follows — which is the shape the provider expects them in.
    if (last?.role === role && Array.isArray(last.content)) {
      last.content.push(block);
      return;
    }
    messages.push({ role, content: [block] });
  };

  /**
   * Adds prose to the open text block if there is one, and starts a new block otherwise.
   *
   * Only ever joins text to *text*: a tool call between two pieces of prose means the model
   * said two things, and joining across it would attribute the second half to before the tool
   * ran.
   */
  const appendText = (role: LLMMessage["role"], text: string): void => {
    const last = messages.at(-1);
    const openBlock = Array.isArray(last?.content) ? last.content.at(-1) : undefined;
    if (last?.role === role && openBlock?.type === "text") {
      openBlock.text += text;
      return;
    }
    push(role, textBlock(text));
  };

  for (const event of events) {
    switch (event.type) {
      case "user.message":
        push("user", textBlock(event.payload.text));
        break;
      case "agent.message":
        // Appended to the block already there when the previous event was also prose, rather
        // than pushed as a new one. An answer reaches the log in pieces now — it is shown as
        // it is written — and the conversation the model is re-sent has to look the way it
        // did when it wrote it: one answer, not a paragraph broken at the sizes the network
        // happened to deliver, and not a message that grows a content block per event.
        appendText("assistant", event.payload.text);
        break;
      case "tool.call": {
        const { toolCallId, toolName, input } = event.payload;
        push("assistant", { type: "tool_use", id: toolCallId, name: toolName, input });
        break;
      }
      case "tool.result": {
        const { toolCallId, ok, output } = event.payload;
        push("user", {
          type: "tool_result",
          toolCallId,
          content: output,
          isError: !ok,
        });
        break;
      }
      default:
        break;
    }
  }

  return messages;
}

/** Groups the log into turns, oldest first, preserving the order events were appended in. */
function toTurns(history: NapEvent[]): Turn[] {
  const byTurn = new Map<string, NapEvent[]>();

  for (const event of history) {
    const existing = byTurn.get(event.turnId);
    if (existing === undefined) {
      byTurn.set(event.turnId, [event]);
      continue;
    }
    existing.push(event);
  }

  return [...byTurn.entries()]
    .map(([id, events]) => ({ id, messages: toMessages(events) }))
    .filter((turn) => turn.messages.length > 0);
}

function blocksOf(messages: LLMMessage[]): LLMContentBlock[] {
  return messages.flatMap((m) => (typeof m.content === "string" ? [] : m.content));
}

function blockTokens(block: LLMContentBlock): number {
  switch (block.type) {
    case "text":
      return estimateTokens(block.text);
    case "tool_use":
      // The name and arguments are what actually travel; the id is a few characters.
      return estimateTokens(`${block.name}${JSON.stringify(block.input)}`);
    case "tool_result":
      return estimateTokens(block.content);
  }
}

function messagesTokens(messages: LLMMessage[]): number {
  return blocksOf(messages).reduce((total, block) => total + blockTokens(block), 0);
}

export class NapContextEngine implements ContextEngine {
  readonly #budgetTokens: number;
  readonly #maxTurns: number;
  readonly #root: string | undefined;
  readonly #maxFileEntries: number | undefined;

  constructor(opts: NapContextEngineOptions = {}) {
    const budgetTokens = opts.budgetTokens ?? DEFAULT_BUDGET_TOKENS;

    if (budgetTokens < MIN_BUDGET_TOKENS) {
      // Thrown rather than returned: there is no sensible context to assemble below this,
      // and a caller asking for one has a bug, not an outcome to handle.
      throw new Error(
        `context budget must be at least ${MIN_BUDGET_TOKENS} tokens, got ${budgetTokens}`,
      );
    }

    this.#budgetTokens = budgetTokens;
    this.#maxTurns = opts.maxTurns ?? DEFAULT_MAX_TURNS;
    this.#root = opts.root;
    this.#maxFileEntries = opts.maxFileEntries;
  }

  async build(request: ContextRequest): Promise<BuiltContext> {
    const memories = await request.memory.retrieve(request.sessionId, request.userMessage);

    let digest = await buildFileTreeDigest(request.sandbox, request.sandboxId, {
      ...(this.#root === undefined ? {} : { root: this.#root }),
      ...(this.#maxFileEntries === undefined ? {} : { maxEntries: this.#maxFileEntries }),
    });

    // The window before the budget is consulted at all: a cap on how far back the agent
    // looks, independent of whether the tokens happen to be available.
    let turns = toTurns(request.history).slice(-this.#maxTurns);
    let remembered: Memory[] = memories;
    let userMessage = request.userMessage;

    const cost = (): number =>
      estimateTokens(systemPrompt(digest, remembered)) +
      messagesTokens(turns.flatMap((turn) => turn.messages)) +
      estimateTokens(userMessage);

    // --- Truncation, in order. Each step is exhausted before the next begins. -----------
    //
    // The order is the design. Tool output goes first because it is the biggest thing in
    // the transcript by a wide margin and the least irreplaceable — the model can re-read a
    // file. Whole turns go next, oldest first, because a conversation degrades from the far
    // end. The file listing goes before either of *those* survivors is touched further,
    // since it is a convenience the agent can rebuild with one tool call. Memories are last
    // because they are the smallest thing here. The turn's own message is cut only when
    // nothing else is left.

    // 1. Elide old tool output, oldest first, keeping the block so the call stays answered.
    for (const turn of turns) {
      if (cost() <= this.#budgetTokens) break;
      for (const block of blocksOf(turn.messages)) {
        if (block.type !== "tool_result") continue;
        if (block.content === ELIDED_TOOL_OUTPUT) continue;
        block.content = ELIDED_TOOL_OUTPUT;
        if (cost() <= this.#budgetTokens) break;
      }
    }

    // 2. Drop whole turns, oldest first. Whole, so a call and its answer leave together.
    while (cost() > this.#budgetTokens && turns.length > 0) {
      turns = turns.slice(1);
    }

    // 3. Give up the file listing.
    if (cost() > this.#budgetTokens) digest = "";

    // 4. Give up retrieved memories.
    if (cost() > this.#budgetTokens) remembered = [];

    // 5. Truncate the turn's own message, so the budget is a guarantee and not a hope.
    if (cost() > this.#budgetTokens) {
      const available = this.#budgetTokens - estimateTokens(systemPrompt(digest, remembered));
      userMessage = truncateToTokens(userMessage, Math.max(available, 0));
    }

    const messages = [
      ...turns.flatMap((turn) => turn.messages),
      { role: "user", content: [textBlock(userMessage)] } satisfies LLMMessage,
    ];
    const prompt = systemPrompt(digest, remembered);

    return {
      systemPrompt: prompt,
      messages,
      estimatedTokens: estimateTokens(prompt) + messagesTokens(messages),
    };
  }
}

/**
 * Stable content first, volatile content after — the order prompt caching requires, since a
 * cache entry is matched by a byte-identical prefix and anything above a change is lost.
 * Placing the cache breakpoint is the provider's job; leaving it somewhere worth placing is
 * this one's.
 */
function systemPrompt(digest: string, memories: Memory[]): string {
  const sections = [SYSTEM_PROMPT];

  if (digest !== "") {
    sections.push(`<project_files>\n${digest}\n</project_files>`);
  }

  // Absent, not empty, when there is nothing to say — an empty section is a section the
  // model reads on every turn in exchange for nothing.
  if (memories.length > 0) {
    const rendered = memories.map((memory) => `- ${memory.content}`).join("\n");
    sections.push(`<memories>\n${rendered}\n</memories>`);
  }

  return sections.join("\n\n");
}

function truncateToTokens(text: string, tokens: number): string {
  if (tokens <= 0) return "";
  if (estimateTokens(text) <= tokens) return text;

  // Keeps the head: a user's request states what they want up front and qualifies it after.
  return text.slice(0, tokens * 4);
}
