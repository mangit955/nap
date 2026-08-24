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
 *
 * Above that order sits a pass that is not part of it, and reading the two as one thing is the
 * mistake to avoid. Truncation asks *does this fit*; staleness asks *is this worth sending*,
 * and answers no for an old turn's tool traffic whether or not the room is needed. The second
 * question exists because the first cannot see the multiplier: a turn re-sends its whole
 * transcript on every round trip, so a kilobyte that fits comfortably is charged ten to forty
 * times against a ceiling this class does not own. See `DEFAULT_VERBATIM_TURNS` and ADR-0011.
 */

import type { NapEvent } from "@nap/shared/events";
import type {
  BuiltContext,
  ContextEngine,
  ContextRequest,
  FailedAttempt,
} from "@nap/shared/ports/context-engine";
import type { LLMContentBlock, LLMMessage } from "@nap/shared/ports/llm-provider";
import type { Memory } from "@nap/shared/ports/memory-provider";
import { buildFileTreeDigest } from "./file-tree.ts";
import { renderJobBrief } from "./job-brief.ts";
import { SYSTEM_PROMPT } from "./system-prompt.ts";
import { estimateTokens, truncateToTokens } from "./tokens.ts";

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

/** The same, for an argument a call was made with — a file's contents, usually. */
export const ELIDED_TOOL_INPUT = "[argument removed; the workspace has moved on since]";

/**
 * How many past turns keep their tool traffic word for word.
 *
 * One, and the reason is arithmetic rather than taste. A turn is many model round trips and
 * every one re-sends the whole transcript, so a turn's bill is roughly the assembled size
 * *times* its step count — and both grow with the session. Measured on the committed log of a
 * funded four-turn run (`packages/context/scripts/measure-audit-session.ts`), 84% of the
 * fourth turn's input was re-sending the first three, and that turn died on the turn budget
 * while the context budget it was assembled against was never within 60,000 tokens of binding.
 *
 * So fitting is not the same as being worth sending, and a ladder that only runs under
 * pressure never ran at all. What an old turn is actually consulted for is what was asked and
 * what the agent said back; the file it wrote is on disk, one `read_file` away, and the
 * command it ran can be run again.
 */
const DEFAULT_VERBATIM_TURNS = 1;

/**
 * How large an argument may be before staleness reaches it.
 *
 * Small enough that a path, a command or a search string survives — losing those would make an
 * old call unreadable, which is the opposite of the point — and far below anything that could
 * be a file's contents or a patch.
 */
const STALE_ARGUMENT_TOKENS = 32;

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
  /** How many of the most recent past turns keep their tool traffic in full. */
  verbatimTurns?: number;
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

/**
 * Strips the bulk out of a turn that is no longer the one being continued.
 *
 * The call stays, with its shape intact — which tool, against which path — so the transcript
 * still reads as a sequence of things that happened. What goes is everything large enough to
 * be a file's contents, an argument at a time, and whatever the call printed back. Both are
 * facts about a workspace that has since been committed over, and the model can re-read the
 * current one for a fraction of what carrying the old one across every remaining round trip
 * costs.
 */
function makeStale(turn: Turn): void {
  for (const block of blocksOf(turn.messages)) {
    if (block.type === "tool_result") {
      block.content = ELIDED_TOOL_OUTPUT;
      continue;
    }
    if (block.type !== "tool_use") continue;
    block.input = Object.fromEntries(
      Object.entries(block.input).map(([key, value]) => [
        key,
        typeof value === "string" && estimateTokens(value) > STALE_ARGUMENT_TOKENS
          ? ELIDED_TOOL_INPUT
          : value,
      ]),
    );
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
  readonly #verbatimTurns: number;

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
    this.#verbatimTurns = Math.max(opts.verbatimTurns ?? DEFAULT_VERBATIM_TURNS, 0);
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

    // Staleness, before the budget is consulted at all. Everything below this point reclaims
    // tokens because the context does not fit; this reclaims them because carrying an old
    // turn's file contents is not worth what it costs even when it does. See
    // `DEFAULT_VERBATIM_TURNS`.
    for (const turn of turns.slice(0, Math.max(turns.length - this.#verbatimTurns, 0))) {
      makeStale(turn);
    }

    let remembered: Memory[] = memories;
    let userMessage = request.userMessage;
    let attempts: readonly FailedAttempt[] = request.job?.attempts ?? [];
    /** A ceiling on each quoted failure. Uncapped until the last resort below applies one. */
    let outputTokens: number | undefined;

    /**
     * What the model is told about the job, or nothing.
     *
     * Nothing on the turn that opens a job, where the objective *is* the message directly
     * below it — a section that restates the request costs tokens on every opening turn and
     * tells the model something it has just been told. Compared trimmed, because an objective
     * is a tidied copy of the message and whitespace is not a difference worth a section.
     */
    const brief = (): string =>
      request.job === undefined ||
      (attempts.length === 0 && request.job.objective === request.userMessage.trim())
        ? ""
        : renderJobBrief({
            objective: request.job.objective,
            attempts,
            ...(outputTokens === undefined ? {} : { outputTokens }),
          });

    const cost = (): number =>
      estimateTokens(systemPrompt(digest, remembered, brief())) +
      messagesTokens(turns.flatMap((turn) => turn.messages)) +
      estimateTokens(userMessage);

    // --- Truncation, in order. Each step is exhausted before the next begins. -----------
    //
    // This ladder runs only when the context does not fit, which on a short session is never.
    // The staleness pass above is what a four-turn session actually meets.
    //
    // The order is the design. Tool output goes first because it is the biggest thing in
    // the transcript by a wide margin and the least irreplaceable — the model can re-read a
    // file. Whole turns go next, oldest first, because a conversation degrades from the far
    // end. The file listing goes before either of *those* survivors is touched further,
    // since it is a convenience the agent can rebuild with one tool call. Memories are next
    // because they are the smallest thing here.
    //
    // What the job is *for* and what its checks last said outlive all of that, and are cut
    // only in the two steps before the turn's own message. That placement is the design too:
    // a long repair with a full context is exactly the situation this section exists for, so
    // dropping it under pressure would degrade the loop precisely where it is needed. Older
    // failures go before the newest one, and the newest one is shortened rather than removed.

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

    // 5. Give up the older failures, oldest first, always keeping the most recent — that one
    //    is the failure being repaired right now, and losing it is losing the turn's subject.
    while (cost() > this.#budgetTokens && attempts.length > 1) {
      attempts = attempts.slice(1);
    }

    // 6. Shorten what the surviving failure printed, keeping its tail. A check can print more
    //    than the whole budget, so a section nothing can shrink would make the budget a wish.
    if (cost() > this.#budgetTokens) {
      // Measured with the quote already gone, so the ceiling is what is left over rather than
      // what is currently spent — and with the turn's own message still paid for, so shrinking
      // a quote can never be what silences the instruction the turn is actually carrying.
      outputTokens = 0;
      const floor = estimateTokens(systemPrompt(digest, remembered, brief()));
      outputTokens = Math.max(this.#budgetTokens - floor - USER_MESSAGE_FLOOR_TOKENS, 0);
    }

    // 7. Truncate the turn's own message, so the budget is a guarantee and not a hope.
    if (cost() > this.#budgetTokens) {
      const available =
        this.#budgetTokens - estimateTokens(systemPrompt(digest, remembered, brief()));
      // The head: a request states what it wants up front and qualifies it after.
      userMessage = truncateToTokens(userMessage, Math.max(available, 0), "head");
    }

    const messages = [
      ...turns.flatMap((turn) => turn.messages),
      { role: "user", content: [textBlock(userMessage)] } satisfies LLMMessage,
    ];
    const prompt = systemPrompt(digest, remembered, brief());

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
function systemPrompt(digest: string, memories: Memory[], job: string): string {
  const sections = [SYSTEM_PROMPT];

  if (digest !== "") {
    sections.push(`<project_files>\n${digest}\n</project_files>`);
  }

  // After the listing rather than before it: within a job the objective does not change and
  // the failures grow, so putting this first would move the listing on every repair turn and
  // lose the cached prefix even on the turns where nothing about the project's files changed.
  if (job !== "") {
    sections.push(job);
  }

  // Absent, not empty, when there is nothing to say — an empty section is a section the
  // model reads on every turn in exchange for nothing.
  if (memories.length > 0) {
    const rendered = memories.map((memory) => `- ${memory.content}`).join("\n");
    sections.push(`<memories>\n${rendered}\n</memories>`);
  }

  return sections.join("\n\n");
}
