/**
 * The loop that takes turn requests off the queue and runs them.
 *
 * It is what turns a durable queue into a system that does anything: an API pod writes down the
 * intent to execute and answers 202, and this claims that intent, leases the session, runs the
 * turn and settles the row. **For now it runs inside the API process**, so one replica behaves
 * exactly as it did before — turns simply flow through the queue on the way — which is what keeps
 * the move to a real worker deployment a change of process rather than a change of behaviour.
 *
 * Three things here are load-bearing.
 *
 * **A lease is renewed, and losing it is fatal.** A worker can outlive its lease through a GC
 * pause, a Postgres blip or a partition, and would then keep appending to a session another worker
 * may already have claimed. So the renewal is conditional on this worker still being the owner, and
 * a renewal that comes back `held: false` aborts the turn immediately rather than waiting for it to
 * finish. Two writers on one session is the failure everything above is arranged to prevent, and
 * this is the last line of it.
 *
 * **Cancellation arrives on the same answer.** One statement asks "do I still hold this, and am I
 * still wanted?", because a worker asking every fifteen seconds is asking one question. The cost is
 * that a cancel is felt within a renewal interval rather than instantly — which is why the process
 * holding the socket also aborts locally, through `running`, when it happens to be this one.
 *
 * **Concurrency is per worker, and the queue decides what it gets.** Nothing here reserves,
 * balances or waits for a particular session: a request whose session is busy is simply not
 * claimable, so a slow turn delays its own session and nobody else's.
 */

import { LEASE_RENEWAL_INTERVAL_MS } from "@nap/shared/lease-windows";
import { getLogger } from "@nap/shared/logging";
import type { ModelCredentials } from "@nap/shared/ports/llm-provider";
import type { Runtime } from "@nap/shared/ports/runtime";
import type { LeasedTurnRequest, TurnQueue } from "@nap/shared/ports/turn-queue";

/**
 * Where a worker announces the turns it is running, for whatever else in this process needs to
 * know — the cancel route, and the reaper's "is this project busy?".
 *
 * A structural type rather than an import: the thing that implements it lives in the API app, and
 * `@nap/runtime` may not depend on an app. It is deliberately per-process and deliberately not
 * authoritative — the queue is. What it buys is that a cancel arriving at the pod already running
 * the turn is felt at once instead of at the next renewal.
 */
export type RunningTurns = {
  adopt(sessionId: string, controller: AbortController): void;
  /** Takes the controller it is releasing, so a settled turn cannot clear its successor's entry. */
  release(sessionId: string, controller: AbortController): void;
};

/** Re-opening the asker's stored credential, for a request they are paying for themselves. */
export type CredentialsFor = (userId: string) => Promise<ModelCredentials | null>;

export type TurnWorkerOptions = {
  queue: TurnQueue;
  runtime: Runtime;
  /**
   * What this worker calls itself, and the predicate every renewal is conditional on.
   *
   * Must identify a *process and its restart* — two workers sharing an owner string could each
   * renew the other's lease, which is the one thing the fencing exists to prevent. A restarted pod
   * with the same name is a different worker and needs a different value, so the default is a
   * random id rather than a hostname.
   */
  owner?: string;
  /** How many requests this worker runs at once. */
  concurrency: number;
  /**
   * How long to wait before asking the queue again, when the last ask found nothing.
   *
   * The floor on how long a turn waits between being accepted and starting, so it is short — the
   * query is an indexed read of a table the size of the backlog. A claim that *does* find work
   * loops straight round rather than waiting.
   */
  pollIntervalMs?: number;
  /** How often a held lease is renewed. Defaults to the shared interval. */
  renewIntervalMs?: number;
  credentialsFor?: CredentialsFor;
  running?: RunningTurns;
};

export type TurnWorker = {
  /**
   * Stops claiming and waits for whatever is already running to finish.
   *
   * Turns in flight are *not* aborted: they hold leases nothing else can take, and killing them
   * would leave a Job open for a human to continue when it was about to close on its own.
   */
  stop(): Promise<void>;
};

/** Short, because it is the delay between a turn being accepted and its first event. */
const DEFAULT_POLL_INTERVAL_MS = 100;

export function startTurnWorker(options: TurnWorkerOptions): TurnWorker {
  const {
    queue,
    runtime,
    concurrency,
    owner = crypto.randomUUID(),
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    renewIntervalMs = LEASE_RENEWAL_INTERVAL_MS,
    credentialsFor,
    running,
  } = options;

  const logger = getLogger();
  const inFlight = new Set<Promise<void>>();
  let stopped = false;
  let idle = Promise.resolve();

  /**
   * One request, start to settled.
   *
   * Everything after the claim is inside the `finally`, because a request left `leased` by a
   * worker that walked away is invisible until its lease expires — a chat pane spinning on an
   * event that will never come.
   */
  async function run(request: LeasedTurnRequest): Promise<void> {
    const controller = new AbortController();
    running?.adopt(request.sessionId, controller);

    const renewal = setInterval(() => {
      void renew(request, controller);
    }, renewIntervalMs);

    try {
      const outcome = await execute(request, controller.signal);
      // Conditional on the owner, so a worker whose lease was reclaimed cannot settle a request
      // somebody else is now running. `false` means exactly that happened, and the row belongs to
      // the janitor now.
      const settled = await queue.settle(request.id, owner, outcome ? "done" : "failed");
      if (!settled) {
        logger.warn(
          { requestId: request.id, sessionId: request.sessionId },
          "turn request could not be settled; the lease was no longer ours",
        );
      }
    } catch (error) {
      // A throw is a bug rather than a failed turn, which is a value. Nothing here can recover it;
      // what matters is that the request still reaches a terminal state.
      logger.error({ err: error, requestId: request.id }, "turn request threw");
      await queue.settle(request.id, owner, "failed").catch((settleError: unknown) => {
        logger.error({ err: settleError, requestId: request.id }, "could not settle a failed turn");
      });
    } finally {
      clearInterval(renewal);
      running?.release(request.sessionId, controller);
    }
  }

  /** Whether the work succeeded. The runtime reports failure as a value; so does this. */
  async function execute(request: LeasedTurnRequest, signal: AbortSignal): Promise<boolean> {
    // Read here rather than carried on the row: the queue stores *whether* the asker pays, never
    // their key, so plaintext credentials never touch the table, a query log, or a backup.
    let credentials: ModelCredentials | undefined;
    if (request.billsToUser) {
      const opened = (await credentialsFor?.(request.userId)) ?? null;
      if (opened === null) {
        // The key was deleted or its secret rotated between admission and here. Failing is the
        // only honest answer: running anyway would bill this deployment for a turn somebody was
        // admitted to on the strength of paying for it themselves.
        logger.error(
          { requestId: request.id, userId: request.userId },
          "a turn billed to its asker had no usable key by the time it was claimed",
        );
        return false;
      }
      credentials = opened;
    }

    if (request.kind === "resume") {
      const outcome = await runtime.resumeSession(request.sessionId, {
        model: request.model,
        // A resume that continues a job runs turns, so it answers to the lease exactly as a turn
        // does. Without the signal the `AbortController` above would be wired to nothing on this
        // branch, and a worker that lost its lease mid-continuation would keep writing.
        signal,
        ...(credentials === undefined ? {} : { credentials }),
      });
      if (!outcome.ok) logger.warn({ requestId: request.id, outcome }, "resume failed");
      return outcome.ok;
    }

    if (request.message === null) {
      // The schema allows it — a `resume` has no prompt — so a `turn` without one is a bug in
      // whatever enqueued it rather than something a model should be asked to interpret.
      logger.error({ requestId: request.id }, "a turn request carried no message");
      return false;
    }

    const outcome = await runtime.runTurn({
      sessionId: request.sessionId,
      message: request.message,
      signal,
      model: request.model,
      ...(credentials === undefined ? {} : { credentials }),
    });
    logger.info({ requestId: request.id, turnId: outcome.turnId, outcome }, "turn settled");
    return outcome.ok;
  }

  /**
   * One renewal, and the two ways it ends a turn.
   *
   * Both abort, and the distinction is only in what is written down: a cancellation is somebody
   * asking, and a lost lease is this worker discovering it is a zombie.
   */
  async function renew(request: LeasedTurnRequest, controller: AbortController): Promise<void> {
    try {
      const result = await queue.renew(request.id, owner);

      if (!result.held) {
        logger.warn(
          { requestId: request.id, sessionId: request.sessionId },
          "lease lost; aborting the turn",
        );
        controller.abort(new Error("the lease on this session was lost"));
        return;
      }

      if (result.cancelRequested) controller.abort(new Error("the turn was cancelled"));
    } catch (error) {
      // A renewal that could not be *asked* is not a lease that was lost: the database is briefly
      // unreachable, and the lease has three of these to spare before it expires. Aborting on the
      // first one would make a blip cost every turn in flight.
      logger.warn({ err: error, requestId: request.id }, "could not renew a lease");
    }
  }

  /** Claims until this worker is full or the queue has nothing for it. */
  async function fill(): Promise<void> {
    while (!stopped && inFlight.size < concurrency) {
      const request = await queue.claim(owner);
      if (request === null) return;

      const task = run(request).finally(() => {
        inFlight.delete(task);
      });
      inFlight.add(task);
    }
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      try {
        await fill();
      } catch (error) {
        // A queue that cannot be read is a database problem, not this loop's. Log and come back:
        // exiting would leave the process alive and permanently deaf to new turns.
        logger.error({ err: error }, "could not claim a turn request");
      }
      if (stopped) break;
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  idle = loop();

  return {
    async stop() {
      stopped = true;
      await idle;
      await Promise.all([...inFlight]);
    },
  };
}
