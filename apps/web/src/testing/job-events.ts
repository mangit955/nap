/**
 * A session's job events, for the two suites that read them.
 *
 * `ev` beside this takes an explicit `seq`, because ordering is the subject of most tests that
 * use it and a hidden counter would make two events written side by side depend on how many
 * were built before them. A job is the other case: it is a *sequence* — opened, verified,
 * repaired, closed — where what matters is the order the steps are in and never the numbers
 * themselves, and writing those by hand is how a fixture ends up asserting on its own
 * arithmetic. So the builder here keeps the counter and the tests keep the story.
 *
 * Shared rather than copied for the reason `events.ts` says beside `ev`: two files that agree
 * by coincidence stop agreeing the day the shape gains a field.
 */

import type { NapEvent, NapEventType, VerifiedCheck } from "@nap/shared/events";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { ev } from "./events.ts";

export const JOB_ID = "5f6a7b8c-9d0e-4f10-a213-456789abcdef";
export const OTHER_JOB_ID = "6a7b8c9d-0e1f-4021-b324-56789abcdef0";

/**
 * A builder over one session's log. Each instance keeps its own `seq`, so two tests in a file
 * cannot number over each other and none of them has to reset anything.
 */
export function jobLog() {
  let seq = 0;

  const at = <T extends NapEventType>(
    type: T,
    payload: Extract<NapEvent, { type: T }>["payload"],
  ): StoredEvent => {
    seq += 1;
    // `as never`: `ev`'s generic cannot be correlated through a second generic wrapper. The
    // call sites are still checked against the union.
    return ev(type, payload as never, seq);
  };

  return {
    at,
    opened: (jobId = JOB_ID, objective = "build a todo list") =>
      at("job.started", { jobId, objective }),
    /** A turn that ended. `null` is a turn that changed nothing, so committed nothing. */
    committed: (commitSha: string | null) =>
      at("turn.completed", {
        usage: { inputTokens: 1, outputTokens: 1 },
        durationMs: 10,
        commitSha,
      }),
    verified: (checks: readonly VerifiedCheck[], jobId = JOB_ID) =>
      at("verification.completed", { jobId, checks: [...checks] }),
    checkpointed: (commitSha: string, jobId = JOB_ID) =>
      at("job.checkpointed", { jobId, commitSha }),
  };
}

/** One check as verification found it. `output` is only ever read for a failure. */
export const check = (
  name: string,
  outcome: VerifiedCheck["outcome"],
  output: string | null = null,
): VerifiedCheck => ({ name, outcome, output });
