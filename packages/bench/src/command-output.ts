/**
 * What a failed command actually said, kept small enough to live in an archived report.
 *
 * The first funded run reported a lint check as `exit 1` and nothing else. The reason —
 * `Script not found "lint"` — was on stderr, which the runner read and threw away, so
 * diagnosing a run that had already been paid for meant paying for another one. A report is
 * supposed to be the artefact you read *instead of* re-running.
 *
 * **Only failures carry it.** Output is diagnostic, and a green suite's build emits hundreds of
 * lines that would land in an artefact people diff — churn that changes run to run for reasons
 * unrelated to any score. A passing check records nothing.
 *
 * **The tail survives, not the head.** A failing build prints its banner first and its reason
 * last, so cutting from the end keeps exactly the part nobody needs.
 *
 * **Each stream is budgeted separately.** A shared budget spent in order lets a chatty stdout
 * push out the stderr that explains the failure, which is precisely the case that motivated
 * this — the message that started it all was twenty-three characters long, on the quiet stream.
 */

import { z } from "zod";

/**
 * Characters kept per stream, not bytes.
 *
 * Bytes would be the honest unit for a cap on how large an artefact may get, but slicing UTF-8
 * at an arbitrary byte splits a code point and puts a replacement character into a report
 * somebody reads months later. The cap exists to keep output readable rather than to account
 * for storage exactly, and command output is overwhelmingly ASCII, where the two agree.
 */
export const OUTPUT_LIMIT_PER_STREAM = 4_096;

export const CapturedStreamSchema = z.strictObject({
  text: z.string(),
  /** Whether anything was dropped. A reader must never mistake a fragment for the whole. */
  truncated: z.boolean(),
});

export const CommandOutputSchema = z.strictObject({
  stdout: CapturedStreamSchema,
  stderr: CapturedStreamSchema,
});

export type CapturedStream = z.infer<typeof CapturedStreamSchema>;
export type CommandOutput = z.infer<typeof CommandOutputSchema>;

/**
 * Captures what a command said, or nothing when it said nothing.
 *
 * `undefined` for a silent command rather than a pair of empty streams: two empty objects on
 * every quiet failure is noise in a diffed artefact, and "recorded nothing" and "said nothing"
 * are the same fact here — there is no third state for a stream that was never read, because
 * the port always hands back both.
 */
export function captureCommandOutput(streams: {
  stdout: string;
  stderr: string;
}): CommandOutput | undefined {
  if (streams.stdout === "" && streams.stderr === "") return undefined;

  return {
    stdout: keepTail(streams.stdout),
    stderr: keepTail(streams.stderr),
  };
}

function keepTail(text: string): CapturedStream {
  if (text.length <= OUTPUT_LIMIT_PER_STREAM) return { text, truncated: false };

  return { text: text.slice(-OUTPUT_LIMIT_PER_STREAM), truncated: true };
}
