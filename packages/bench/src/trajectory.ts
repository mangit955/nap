/**
 * The run's events, kept whole beside its report.
 *
 * A score says whether the agent arrived; the trajectory says how. That is the interesting
 * half of comparing two models that scored the same — one wrote the file twice and ran the
 * build once, the other ran the build eleven times — and none of it survives being summarised
 * into counts. So the stream is archived verbatim, and the derived figures are computed from
 * it rather than replacing it.
 *
 * **The metrics are not in here.** They live in the report, which is the artefact people
 * actually read and diff; a second copy beside the events could disagree with the first, and
 * the whole point of deriving them from the log is that there is one source. The two files
 * are one record — same task id, same run id, same directory — and either can be read alone.
 *
 * Validated on the way back in, like a report: an archived stream is untrusted input by the
 * time anybody compares two of them, and events are exactly the shape whose contract may have
 * moved on since. See `CONTEXT.md` for what "trajectory" means, and docs/adr/0003 for why
 * this is the existing event stream rather than a second instrumentation path.
 */

import { NapEventSchema } from "@nap/shared/events";
import type { Result } from "@nap/shared/result";
import { z } from "zod";
import { describeParseFailure } from "./parse-failure.ts";

export const BenchTrajectorySchema = z.strictObject({
  /** The same three ids the report carries, so a loose file can be matched back to one. */
  runId: z.uuid(),
  taskId: z.string().min(1),
  sessionId: z.uuid(),
  /**
   * Every event the session produced, in `seq` order.
   *
   * Whole rather than filtered: what looks irrelevant to today's metrics — a thinking block,
   * a system notice — is exactly what somebody re-reads when a score is surprising.
   */
  events: z.array(NapEventSchema),
});

export type BenchTrajectory = z.infer<typeof BenchTrajectorySchema>;

/**
 * Compact, unlike a report.
 *
 * A trajectory is machine input — read back by `compare`, not by a person scanning a diff —
 * and a long agentic run's stream indented to two spaces is a file nobody can open.
 */
export function serialiseBenchTrajectory(trajectory: BenchTrajectory): string {
  return `${JSON.stringify(trajectory)}\n`;
}

export function parseBenchTrajectory(input: unknown): Result<BenchTrajectory, string> {
  const parsed = BenchTrajectorySchema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };

  return { ok: false, error: describeParseFailure(parsed.error, "trajectory") };
}
