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
  /**
   * The id this turn's events are written under, allocated by the caller.
   *
   * Passed in rather than generated here, because the turn's identity has to exist before the
   * turn does: the queue row admission writes *is* this id, so the janitor can close the right
   * Turn for a worker that died without ever having run one. Anything driving the runtime
   * directly — the harness, the benchmark — allocates its own.
   *
   * It names the turn this request *begins*. A repair is a distinct Turn and takes a fresh id.
   */
  turnId: string;
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
  /**
   * The id the resume's own events are written under — the same rule a turn's `turnId` follows,
   * and for the same reason: a resume is a queued request too, and its row's id is this.
   *
   * Optional only because `resumeSession` is reachable from places no queue admitted, such as a
   * test or a script. A resume that came off the queue always carries one.
   */
  turnId?: string | undefined;
  model?: string | undefined;
  credentials?: ModelCredentials | undefined;
  /**
   * How to stop the work a continuation turns out to involve.
   *
   * A third thing, and unlike the two above it is not about who asked: a resume that continues a
   * job runs turns, and a worker that has lost its session's lease must be able to stop them at
   * once. Without it that worker would keep appending to a session another one may already have
   * claimed — the failure the whole lease exists to prevent, reached through the one entry point
   * that had no way to be interrupted.
   *
   * It does not abort the restore itself, which is a few seconds of provider calls with nothing
   * to roll back. What it reaches is the continuation, which is the part that takes minutes.
   */
  signal?: AbortSignal | undefined;
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
