/**
 * Asking a model for a session's title, and deciding whether its answer is one.
 *
 * The trimmed first prompt (`project-title.ts`) is still the instant seed; this is what replaces
 * it when a model's answer arrives and passes `cleanTitle`. See docs/adr/0031.
 *
 * The prompt is adapted from T3 Code's `INITIAL_THREAD_TITLE_PROMPT` and its regenerate prompt,
 * in `packages/provider-core/src/server/textGenerationPrompts.ts` at `pingdotgg/t3code@5127302`:
 *
 *   MIT License. Copyright (c) 2026 T3 Tools Inc.
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy of this software
 *   and associated documentation files (the "Software"), to deal in the Software without
 *   restriction, including without limitation the rights to use, copy, modify, merge, publish,
 *   distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
 *   Software is furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all copies or
 *   substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING
 *   BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
 *   NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
 *   DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 *
 * Nap's changes: it asks for the title as one line of plain text rather than JSON, drops what
 * only applies to T3 (tools, linked pull requests, attachments, the git checkout), and checks
 * the editorial rules in code as well as stating them.
 */

import { z } from "zod";
import { UNTITLED_PROJECT } from "./project-title.ts";

/** Where a project's name came from. A `user` name is never replaced by anything automatic. */
export const NameSourceSchema = z.enum(["seed", "model", "user"]);
export type NameSource = z.infer<typeof NameSourceSchema>;

/** T3's limits: a title is 3 to 8 words and fewer than 40 characters. */
export const TITLE_MIN_WORDS = 3;
export const TITLE_MAX_WORDS = 8;
export const TITLE_MAX_LENGTH = 39;
/** How much of the person's words a title request carries, so its cost stays bounded. */
export const TITLE_INITIAL_CHARACTERS = 2000;
export const TITLE_REGENERATE_CHARACTERS = 4000;
/** Room for a title and nothing else: no reasoning, no preamble. */
export const TITLE_MAX_OUTPUT_TOKENS = 64;

export const TITLE_SYSTEM_PROMPT =
  "You write short titles for coding sessions. Reply with the title only, on one line.";

const EDITORIAL_RULES = `Editorial rules:
- 3-8 words, fewer than 40 characters.
- Use a compact noun phrase or clear action phrase.
- Capture the umbrella goal when the request lists several symptoms or steps.
- Name the product change, not the mock, plan, report, branch, or PR used to produce it.
- Models, tools, output formats, and instructions about how to work do not belong in the title unless they are themselves the topic.
- Do not claim the work is complete.
- Do not copy and truncate the user's message.
- Avoid project or repository names already visible in the UI, quotes, labels, filler, and trailing punctuation.`;

const INITIAL_TITLE_PROMPT = `Generate a title that will help the user recognize this session weeks later.

Before answering, silently reduce the request to:
- Subject: What system, feature, or problem is this really about?
- Outcome: What does the user ultimately want to understand or change?
- Incidental instructions: What only describes how the agent should do the work?

Title the subject and outcome. Discard incidental instructions.

${EDITORIAL_RULES}`;

function regeneratePrompt(previousTitle: string): string {
  return `Regenerate the title for an existing session so the user can recognize it weeks later.
The previous title was ${JSON.stringify(previousTitle)}.

The messages below are the user's, oldest first. The original subject remains the subject until the user clearly changes what the session is about. Replace the previous title when it is generic, a fragment of the first message, or contradicted by later messages.

${EDITORIAL_RULES}`;
}

/** The text of a title request. `previousTitle` present means the person asked to regenerate. */
export function titlePrompt(input: {
  messages: readonly string[];
  previousTitle?: string;
}): string {
  if (input.previousTitle === undefined) {
    const message = (input.messages[0] ?? "").slice(0, TITLE_INITIAL_CHARACTERS);
    return `${INITIAL_TITLE_PROMPT}\n\nUser message:\n${message}`;
  }
  return `${regeneratePrompt(input.previousTitle)}\n\nUser messages:\n${boundedMessages(input.messages)}`;
}

/** The first message and as many of the latest as fit, each cut short, within the bound. */
function boundedMessages(messages: readonly string[]): string {
  const share = Math.floor(TITLE_REGENERATE_CHARACTERS / Math.max(1, Math.min(messages.length, 4)));
  return messages
    .map((message) => message.slice(0, share))
    .join("\n---\n")
    .slice(0, TITLE_REGENERATE_CHARACTERS);
}

/** Lowercase letters and digits only: what two strings have to share to be "the same words". */
function comparable(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/**
 * The model's answer as a title, or null when it is not one and the current name should stay.
 *
 * Tidied first (the first line, without surrounding quotes, a `Title:` label or trailing
 * punctuation), then held to T3's rules: 3 to 8 words, fewer than 40 characters, not a copy or a
 * truncation of what the person wrote, and not the source name the card already shows.
 */
export function cleanTitle(
  raw: string,
  context: { messages: readonly string[]; sourceName: string | null },
): string | null {
  const firstLine =
    raw
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line !== "") ?? "";
  const title = firstLine
    .replace(/^title\s*:\s*/i, "")
    .replace(/^["'“”‘’`*_]+|["'“”‘’`*_]+$/g, "")
    .replace(/[\s.,;:!?…]+$/u, "")
    .replace(/\s+/g, " ")
    .trim();

  const words = title.split(" ").filter((word) => word !== "");
  if (words.length < TITLE_MIN_WORDS || words.length > TITLE_MAX_WORDS) return null;
  if (title.length > TITLE_MAX_LENGTH) return null;

  const mine = comparable(title);
  if (mine === "" || mine === comparable(UNTITLED_PROJECT)) return null;
  for (const message of context.messages) {
    const theirs = comparable(message);
    // A copy, or the message's opening words: T3's "never a truncated copy of the message".
    if (theirs.startsWith(mine)) return null;
  }
  if (context.sourceName !== null) {
    const source = comparable(context.sourceName);
    const shortSource = comparable(context.sourceName.slice(context.sourceName.indexOf("/") + 1));
    if (mine === source || mine === shortSource) return null;
  }
  return title;
}
