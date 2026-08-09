/**
 * The query string of `/ws?sessionId=…&seq=N`.
 *
 * `seq` is where a client says what it has already seen, so a wrong value is not a cosmetic
 * problem: falling back to 0 on an unparseable one would replay an entire transcript into a
 * reconnecting client and show every message twice. Anything malformed is refused before the
 * upgrade, while a plain HTTP response can still explain why.
 */

import type { Result } from "@nap/shared/result";
import { z } from "zod";

export type StreamQuery = {
  sessionId: string;
  /** Send events *after* this sequence number; 0 means the whole transcript. */
  afterSeq: number;
};

const StreamQuerySchema = z.object({
  sessionId: z.uuid(),
  /**
   * Absent means "from the beginning". Present means it must be a real sequence number —
   * matched as digits rather than coerced, because `Number("")` is 0 and `?seq=` would then
   * be indistinguishable from asking for the whole transcript.
   */
  seq: z.string().regex(/^\d+$/, "must be a non-negative integer").transform(Number).optional(),
});

export function parseStreamQuery(url: URL): Result<StreamQuery, { message: string }> {
  const seq = url.searchParams.get("seq");
  const parsed = StreamQuerySchema.safeParse({
    sessionId: url.searchParams.get("sessionId") ?? undefined,
    ...(seq === null ? {} : { seq }),
  });

  if (!parsed.success) {
    // Every problem in one message, matching how the environment check reports.
    const message = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return { ok: false, error: { message } };
  }

  return { ok: true, value: { sessionId: parsed.data.sessionId, afterSeq: parsed.data.seq ?? 0 } };
}
