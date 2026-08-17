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
import type { ModelCredentials } from "./llm-provider.ts";

export type TurnRequest = {
  sessionId: string;
  message: string;
  signal?: AbortSignal;
  /** Which model to run on. Absent is the deployment's default; the route validates it. */
  model?: string | undefined;
  /**
   * Whose account pays. Absent is the deployment's own, which is what a turn on the free
   * models runs on.
   *
   * Resolved by the route, because that is the only layer that knows who is asking — and it
   * resolves the *model* at the same time and from the same fact, since which models somebody
   * may reach depends on whether they brought a key.
   */
  credentials?: ModelCredentials | undefined;
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

/**
 * Why a project could not be started back up. Narrower than a turn's reasons on purpose: no
 * model ran, so nothing here can be a refusal or a budget.
 */
export type ResumeFailureReason =
  /** No sandbox could be started, so there is nowhere to put the project. */
  | "sandbox_unavailable"
  /** Something above the sandbox broke — a store that could not be read, a bug. */
  | "internal";

export type ResumeOutcome =
  | {
      ok: true;
      sandboxId: string;
      /** False when the project was already running and this only pushed its timer back. */
      created: boolean;
    }
  | { ok: false; reason: ResumeFailureReason; message: string };

/**
 * What a job continued by an open should run on, if it runs anything.
 *
 * The same two things a turn may override and for the same reason — they are facts about who
 * asked rather than preferences. A continuation is work somebody already started, so it is
 * billed to whoever is standing in front of it now: leaving these out would have the deployment
 * quietly pay for the repair loop of a user who brought their own key.
 */
export type ContinueOptions = {
  model?: string | undefined;
  credentials?: ModelCredentials | undefined;
};

export interface Runtime {
  runTurn(request: TurnRequest): Promise<TurnOutcome>;

  /**
   * Brings a put-away project back up, and continues the job a restart left open in it.
   *
   * A project outlives its sandbox: the sweep destroys idle ones and the provider reclaims the
   * rest, leaving the work in a snapshot. Restoring it used to happen only as a side effect of
   * sending a message, which made looking at what you built cost a model call — and left the
   * preview pane pointed at an address that had stopped answering until you did.
   *
   * **Continuing is deliberately tied to this and to nothing else.** A job open at a restart is
   * neither failed nor dropped, but nothing sweeps for one either: an autonomous loop that
   * spends tokens with nobody watching is a bill. Somebody opening the project is the evidence
   * that a person is there. Most opens continue nothing — see `CONTEXT.md`, *Continue*.
   *
   * Reports the outcome for the caller to log. What the *user* sees arrives as events on the
   * session, because a restore, and anything it continues, outlasts the request that asked for
   * it.
   */
  resumeSession(sessionId: string, options?: ContinueOptions): Promise<ResumeOutcome>;
}
