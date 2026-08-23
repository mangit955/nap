/**
 * The loop that takes turn requests off the queue and runs them.
 *
 * It is what turns a durable queue into a system that does anything: an API pod writes down the
 * intent to execute and answers 202, and this claims that intent, leases the session, runs the
 * turn and settles the row. It is what a worker process *is*: `apps/api/src/worker.ts` composes
 * Nap with everything else switched off and this loop running, and the API process composes the
 * same system with this loop not started. Nothing here knows which, and that is the point — the
 * queue is the only thing the two halves share.
 *
 * Five things here are load-bearing.
 *
 * **Queue delivery may be at-least-once; logical Turn execution is at-most-once.** Nothing here
 * retries a request and nothing puts one back on the queue, so a worker that dies mid-turn leaves a
 * partial log rather than a turn that ran twice — and the request's own id is the turn id its events
 * were written under, which is how the janitor closes out a Turn it never ran. That trade is only
 * affordable because a partial log is a first-class input: `foldJobs` reads one and a human
 * reopening the project continues from it. See `docs/scaling-design.md` §6.
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
 *
 * **Stopping is a drain with a deadline, and the leases stay renewed for the whole of it.** A
 * worker being taken away waits for its turns rather than killing them, but only for as long as
 * the platform's grace period allows — and it keeps renewing throughout, or it would spend the
 * wait having its own progressing work orphaned out from under it.
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
  /**
   * How long an aborted turn is given to actually stop before this worker gives up on it.
   *
   * Exists to be turned down in a test: a turn that ignores its signal is what it guards against,
   * and there is no other way to produce one on demand.
   */
  abortGraceMs?: number;
  /**
   * How long a drain waits for turns already in flight before aborting them.
   *
   * A worker asked to stop is a worker whose process is being taken away, and the platform's
   * grace period is the real deadline: a drain that outlasts it is not a graceful shutdown but a
   * kill, which leaves every lease it held to expire and every job it opened for somebody to
   * continue by hand. So the default is `docs/scaling-design.md` §15's 600s, comfortably inside
   * the 900s grace — long enough for a job with verification and three repairs, short enough that
   * the abort happens on our terms rather than SIGKILL's.
   */
  drainTimeoutMs?: number;
  credentialsFor?: CredentialsFor;
  running?: RunningTurns;
  /**
   * Called every time round the claim loop, whether or not there was anything to claim.
   *
   * What it exists for is liveness. A worker has no port, so "is this process alive?" cannot be
   * asked over HTTP, and the only honest question is whether this loop is still going round: a
   * wedged one — a pool deadlock, a promise that never settles — leaves a pod that is up, holds no
   * leases and runs nothing, which no other kind of probe can see.
   *
   * *Whether or not* is the load-bearing half. A heartbeat driven by claimed work would stop
   * during every quiet spell, so an idle deployment would restart its workers on a timer; and one
   * that skipped a failed claim would restart them during a database blip, which is when losing
   * the turns in flight helps least. This says "the loop is going round", nothing more.
   *
   * Deliberately synchronous and deliberately unawaited: it is called on the hot path of a loop
   * that polls several times a second, and a slow one should show up as a slow loop rather than
   * quietly holding up the next claim.
   */
  onClaimTick?: () => void;
};

export type TurnWorker = {
  /**
   * Stops claiming and waits for whatever is already running to finish, up to `drainTimeoutMs`.
   *
   * Turns in flight are *not* aborted while there is still time: they hold leases nothing else can
   * take, and killing one would leave a Job open for a human to continue when it was about to
   * close on its own. Their leases keep being renewed throughout, or this worker's own drain would
   * hand its work to the janitor.
   *
   * Past the deadline they are aborted, which is a clean stop rather than a kill — the runtime
   * commits nothing and closes the job `abandoned` — and each request is still settled here.
   */
  stop(): Promise<void>;
};

/** Short, because it is the delay between a turn being accepted and its first event. */
const DEFAULT_POLL_INTERVAL_MS = 100;

/**
 * `docs/scaling-design.md` §15: inside the 900s grace period, with room for the tail.
 *
 * The number a deployment actually runs on is `NAP_DRAIN_TIMEOUT_SECONDS`, which the composition
 * passes in; this is only what a caller that named none gets.
 */
const DEFAULT_DRAIN_TIMEOUT_MS = 600_000;

/**
 * How long an aborted turn has to actually stop.
 *
 * Seconds rather than minutes: everything a turn is waiting on is already cancelled by this point,
 * so anything still running is not honouring its signal, and no amount of further waiting inside a
 * grace period that is nearly over will change that.
 */
const ABORT_GRACE_MS = 10_000;

export function startTurnWorker(options: TurnWorkerOptions): TurnWorker {
  const {
    queue,
    runtime,
    concurrency,
    owner = crypto.randomUUID(),
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    renewIntervalMs = LEASE_RENEWAL_INTERVAL_MS,
    drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
    abortGraceMs = ABORT_GRACE_MS,
    credentialsFor,
    running,
    onClaimTick,
  } = options;

  const logger = getLogger();
  const inFlight = new Set<Promise<void>>();
  /**
   * The controller of every turn running here, so a drain that runs out of time can end them.
   *
   * Kept beside `inFlight` rather than derived from it: a promise says when a turn finished and
   * nothing about how to stop it.
   */
  const controllers = new Set<AbortController>();
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
    controllers.add(controller);

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
      controllers.delete(controller);
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
        // The request's id *is* the turn id its events go under, so a janitor closing this out
        // later can name the same Turn without having run it.
        turnId: request.id,
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
      turnId: request.id,
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
      // After the claim rather than before it, and outside the `try` so a failed claim still
      // counts: what this reports is that the loop came round, which is true either way.
      try {
        onClaimTick?.();
      } catch (error) {
        // A liveness heartbeat that can kill the loop it reports on would be worse than none.
        logger.error({ err: error }, "the claim tick handler threw");
      }
      if (stopped) break;
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  }

  idle = loop();

  /**
   * The drain: wait for what is running, and end it if the wait runs out.
   *
   * The renewal timers are deliberately untouched — each one lives inside its own `run`, so every
   * turn being waited for keeps its lease for as long as the wait lasts. A drain that let them
   * lapse would have the janitor orphan this worker's own progressing turns and hand their
   * sessions to somebody else while this process was still writing to them.
   */
  async function drain(): Promise<void> {
    if (inFlight.size === 0) return;
    const draining = Promise.all([...inFlight]);

    let expiry: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<"expired">((resolve) => {
      expiry = setTimeout(() => resolve("expired"), drainTimeoutMs);
    });

    const outcome = await Promise.race([draining.then(() => "drained" as const), deadline]);
    clearTimeout(expiry);
    if (outcome === "drained") return;

    // Out of time. Aborting is a clean stop rather than a kill: the runtime commits nothing and
    // closes the job `abandoned`, and each `run` still settles its own request on the way out —
    // which is what releases the lease before this process disappears.
    logger.warn(
      { inFlight: controllers.size, drainTimeoutMs },
      "the drain timed out; aborting the turns still running",
    );
    for (const controller of controllers) {
      controller.abort(new Error("the worker is shutting down"));
    }

    // Bounded, not `await draining`. An abort is a request, and a runtime that does not honour one
    // would otherwise leave `stop()` pending for ever — which means the caller's `process.exit`
    // never runs and the platform reaches for SIGKILL, the exact ending the deadline exists to
    // prevent. Giving up here loses the settle for those requests; the janitor closes them out
    // once their leases expire, which is what it is for.
    let abandonment: ReturnType<typeof setTimeout> | undefined;
    const abandoned = new Promise<"abandoned">((resolve) => {
      abandonment = setTimeout(() => resolve("abandoned"), abortGraceMs);
    });

    const ending = await Promise.race([draining.then(() => "drained" as const), abandoned]);
    clearTimeout(abandonment);
    if (ending === "abandoned") {
      logger.error(
        { inFlight: controllers.size },
        "turns did not stop when aborted; leaving them to the janitor",
      );
    }
  }

  return {
    async stop() {
      stopped = true;
      await idle;
      await drain();
    },
  };
}
