/**
 * What the model is told about the job the turn belongs to.
 *
 * Two facts, and the second is the point. The **objective** is what was asked, which stops
 * being recoverable from the conversation the moment the turn that asked it falls out of the
 * window — exactly the long repair this section exists for. The **failures already seen** are
 * procedural memory in miniature: "you have tried this and it did not work" is the one thing a
 * model cannot derive from a transcript of its own confident work.
 *
 * It quotes and asserts nothing, like the repair prompt it sits behind (`repair-prompt.ts`):
 * every word about a failure comes from the check. A diagnosis here would be one the model
 * carries into every remaining attempt, and there are only three.
 *
 * The output ceiling is the budget's, not this module's. A check can print a megabyte, and
 * this section is near-unevictable — so something has to be able to make it smaller without
 * removing it, and shrinking the quote is that something. The **tail** survives, because the
 * reason a build failed is at the end of what it printed (`renderCheckOutput`).
 */

import type { FailedAttempt } from "@nap/shared/ports/context-engine";
import { truncateToTokens } from "./tokens.ts";

export type JobBriefOptions = {
  /** What was asked, as the prompt that opened the job put it. */
  objective: string;
  /** Failures already seen, oldest first, already narrowed by whatever budget applies. */
  attempts: readonly FailedAttempt[];
  /** Ceiling on each quoted output. Uncapped when absent. */
  outputTokens?: number;
};

export function renderJobBrief(options: JobBriefOptions): string {
  const { objective, attempts, outputTokens } = options;

  const sections = [`This turn is part of a job. What was asked:\n\n${objective}`];

  // Absent rather than empty when nothing has failed, which is every first turn: a heading
  // over an empty list is read on every request in exchange for nothing.
  if (attempts.length > 0) {
    sections.push(
      `The project's own checks have already failed ${times(attempts.length)} on this job. ` +
        "Oldest first, this is what they said. Whatever was tried before each one did not fix " +
        "it — do not try that again.",
      ...attempts.map(
        (attempt, index) =>
          `${index + 1}. \`${attempt.check}\` (${attempt.detail})\n${quoted(attempt.output, outputTokens)}`,
      ),
    );
  }

  return `<job>\n${sections.join("\n\n")}\n</job>`;
}

/** English rather than a count, because the first repair is the common case and reads badly. */
function times(count: number): string {
  return count === 1 ? "once" : `${count} times`;
}

/**
 * What the check said, fenced so the model reads it as output rather than as instructions.
 *
 * A check can fail silently — a non-zero exit and nothing on either stream — and saying so
 * beats an empty fence, which reads as "it said nothing important".
 */
function quoted(output: string | null, tokens: number | undefined): string {
  if (output === null) return "It printed nothing; the exit code is all there was to go on.";
  if (tokens !== undefined && tokens <= 0) return "Its output did not fit this turn's budget.";

  // The tail, because the reason a build failed is at the end of what it printed.
  const kept = tokens === undefined ? output : truncateToTokens(output, tokens, "tail");

  return `\`\`\`\n${kept}\n\`\`\``;
}
