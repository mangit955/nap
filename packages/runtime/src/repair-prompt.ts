/**
 * The prompt a failed check writes.
 *
 * A repair is a Turn whose prompt came from the verifier rather than from the user
 * (`docs/adr/0006`), and this is that prompt. It is prose, so it is here rather than in
 * `@nap/verify`: the verifier's result is data on purpose — its other reader is an event
 * payload — and turning data into a sentence for a model is the composition step.
 *
 * Three things it deliberately does.
 *
 * **It quotes, and asserts nothing.** Every word about the failure comes from the check: its
 * name, its detail, its output. Nothing here diagnoses the cause, because a wrong diagnosis in
 * the prompt is a repair attempt spent on the wrong file, and there are only three.
 *
 * **It says which attempt this is.** The model cannot see the loop it is in, and "this is the
 * last attempt" is the difference between a broad refactor and a narrow fix.
 *
 * **It never names the check's command.** What the project means by `test` is the project's,
 * and a prompt that repeated the command would invite the model to run something else instead
 * of fixing what the command found.
 */

import { MAX_REPAIR_ATTEMPTS } from "@nap/shared/job-state";
import type { CheckFailure } from "./verify-turn.ts";

export type RepairPromptOptions = {
  /** The check that said no. Short-circuiting means there is exactly one. */
  failed: CheckFailure;
  /** Which repair this is, counting from one. */
  attempt: number;
};

export function repairPrompt(options: RepairPromptOptions): string {
  const { failed, attempt } = options;

  return [
    "Your last change is committed, but the project's own checks do not pass, so the work is " +
      "not finished.",
    `The \`${failed.name}\` check failed (${failed.detail}).`,
    quoted(failed),
    "Find the cause and fix it. The same checks run again the moment you stop, and nothing " +
      "else about the request has changed — do not start over, and do not change anything the " +
      "failure does not point at.",
    `This is repair attempt ${attempt} of ${MAX_REPAIR_ATTEMPTS}.`,
  ].join("\n\n");
}

/**
 * What the check said, fenced so a model reads it as output rather than as instructions.
 *
 * A check can fail silently — a non-zero exit and nothing on either stream — and saying so is
 * better than an empty code fence, which reads as "it said nothing important".
 */
function quoted(failed: CheckFailure): string {
  if (failed.output === null) return "It printed nothing; the exit code is all there is to go on.";

  return `It said:\n\n\`\`\`\n${failed.output}\n\`\`\``;
}

/**
 * The commit subject for a repair turn.
 *
 * A project's git history is the record of the conversation, and a repair turn has no user
 * message to name itself after — using the synthesized prompt would put a paragraph of
 * instructions in the log. This says what the commit was for instead.
 */
export function repairCommitSubject(failed: CheckFailure, attempt: number): string {
  return `Repair ${attempt}: ${failed.name}`;
}
