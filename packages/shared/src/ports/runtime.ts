/**
 * Turn orchestration: acquire a sandbox, build context, run the agent, persist each
 * event and then publish it, commit on success, snapshot. Budgets, cancellation and
 * failure recovery live here too.
 *
 * It owns none of the things it coordinates — no prompt content, no model parameters,
 * no tool implementations.
 *
 * A failed turn leaves the workspace at the last good commit, which is why failure is a
 * value here rather than an exception: the caller has to be handed the reason so it can
 * be surfaced, and `reason` reuses the vocabulary of the `turn.failed` event rather than
 * inventing a second one that would have to be mapped.
 */

import type { TurnFailureReason } from "../events.ts";

export type TurnRequest = {
  sessionId: string;
  message: string;
  signal?: AbortSignal;
};

export type TurnOutcome =
  | {
      ok: true;
      turnId: string;
      /** `null` when the turn changed no files, so there was nothing to commit. */
      commitSha: string | null;
    }
  | {
      ok: false;
      turnId: string;
      reason: TurnFailureReason;
      message: string;
    };

export interface Runtime {
  runTurn(request: TurnRequest): Promise<TurnOutcome>;
}
