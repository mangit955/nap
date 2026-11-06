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
 * still wanted?", because a worker asking every fifteen seconds is asking one question. A cancel
 * wake-up changes *when* it is asked and nothing else: it makes this worker ask straight away, so a
 * stop is felt in milliseconds, and it is the row's answer rather than the notification that aborts
 * anything. A wake-up that never arrives leaves the next renewal to find the same flag.
 *
 * **Concurrency is per worker, and the queue decides what it gets.** Nothing here reserves,
 * balances or waits for a particular session: a request whose session is busy is simply not
 * claimable, so a slow turn delays its own session and nobody else's.
 *
 * **An idle worker waits to be told, and polls slowly in case it is not.** Whatever writes a
 * claimable request — admission, a settle that frees a session, the janitor — announces it after
 * committing, and this asks the queue the moment it hears one, or the moment a turn of its own
 * finishes. Between those it asks once per fallback interval, which is what a lost wake-up costs.
 * A worker that cannot hear wake-ups polls at the fast interval instead, as it did before any of
 * this existed. See `docs/adr/0027`.
 *
 * **Stopping is a drain with a deadline, and the leases stay renewed for the whole of it.** A
 * worker being taken away waits for its turns rather than killing them, but only for as long as
 * the platform's grace period allows — and it keeps renewing throughout, or it would spend the
 * wait having its own progressing work orphaned out from under it.
 */

import { LEASE_RENEWAL_INTERVAL_MS } from "@nap/shared/lease-windows";
import { getLogger } from "@nap/shared/logging";
import type { CancelChannel, StopListening } from "@nap/shared/ports/cancel-channel";
import type { ClaimChannel } from "@nap/shared/ports/claim-channel";
import type { ModelCredentials } from "@nap/shared/ports/llm-provider";
import type { Runtime } from "@nap/shared/ports/runtime";
import type { LeasedTurnRequest, TurnQueue } from "@nap/shared/ports/turn-queue";
import { TurnAbortError } from "@nap/shared/turn-abort";

/**
 * Where a worker announces the turns it is running, for whatever else in this process needs to
 * know. That is only ever the cancel route, in a composition that runs both halves in one process.
 *
 * Keyed by request rather than session, because a session outlives any one turn on it: a cancel
 * that named the session could land on the turn after the one somebody meant to stop.
 *
 * A structural type rather than an import: the thing that implements it lives in the API app, and
 * `@nap/runtime` may not depend on an app. It is deliberately per-process and deliberately not
 * authoritative — the queue is. What it buys there is that a cancel is felt at once instead of at
 * the next renewal.
 */
export type RunningTurns = {
  adopt(requestId: string, controller: AbortController): void;
  release(requestId: string, controller: AbortController): void;
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
   * How long to wait before asking the queue again, when the last ask found nothing and this worker
   * cannot hear claim wake-ups — none were given, the `LISTEN` failed or never answered, or the
   * listener says it has gone deaf.
   *
   * Short, because then it is the floor on how long a turn waits between being accepted and
   * starting. A claim that *does* find work loops straight round rather than waiting.
   */
  pollIntervalMs?: number;
  /**
   * How long to wait between asks while wake-ups are being heard.
   *
   * Only a lost wake-up waits this long, so it is the bound on how late such a request starts, and
   * it is also the idle cadence of `onClaimTick`. See `DEFAULT_FALLBACK_POLL_INTERVAL_MS`.
   */
  fallbackPollIntervalMs?: number;
  /**
   * What tells an idle worker that a request may have become claimable. Absent means polling at
   * `pollIntervalMs`, which is correct and costs a claim query every interval.
   */
  claims?: Pick<ClaimChannel, "listen" | "hearing">;
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
   * What makes a cancel felt before the next renewal. Only the listening half, because the route is
   * what announces. Absent means renewals alone, which is still correct and up to one interval slow.
   */
  cancels?: Pick<CancelChannel, "listen">;
  /**
   * How long the first claim, and then `stop()`, will wait on the channel answering. Exists to be
   * turned down in a test, for the reason `abortGraceMs` does.
   */
  listenTimeoutMs?: number;
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
   * An idle worker that hears wake-ups comes round once per fallback interval, and one that does
   * not, once per poll interval — both far inside the two minutes the worker's liveness probe
   * allows. Deliberately synchronous and deliberately unawaited: a slow one should show up as a
   * slow loop rather than quietly holding up the next claim.
   */
  onClaimTick?: () => void;
  /** A publication retry uses the session lease and cancellation without spending model tokens. */
  publish?: (request: LeasedTurnRequest, signal: AbortSignal) => Promise<boolean>;
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

/**
 * Short, because without wake-ups it is the delay between a turn being accepted and its first
 * event. It is also ten claim transactions a second per idle worker, for ever, which is why it is
 * only the cadence of a worker that cannot hear.
 */
const DEFAULT_POLL_INTERVAL_MS = 100;

/**
 * Five seconds: fifty times fewer claim transactions than the fast interval, and still a small
 * fraction of what a turn takes once it starts, so a request whose wake-up was lost starts late
 * rather than noticeably stuck. It also matches the heartbeat writer's own five-second throttle, so
 * an idle worker's liveness file is touched about as often as it was before.
 *
 * The number a deployment runs on is `NAP_WORKER_FALLBACK_POLL_SECONDS`, which the composition
 * passes in.
 */
const DEFAULT_FALLBACK_POLL_INTERVAL_MS = 5_000;

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

/**
 * How long a `LISTEN` or an `UNLISTEN` may go unanswered.
 *
 * A round trip on a socket opened moments ago, so seconds is already a socket in trouble, and the
 * driver sets no limit of its own. Short enough that a turn accepted meanwhile barely notices.
 */
const LISTEN_TIMEOUT_MS = 5_000;

export function startTurnWorker(options: TurnWorkerOptions): TurnWorker {
  const {
    queue,
    runtime,
    concurrency,
    owner = crypto.randomUUID(),
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    fallbackPollIntervalMs = DEFAULT_FALLBACK_POLL_INTERVAL_MS,
    renewIntervalMs = LEASE_RENEWAL_INTERVAL_MS,
    drainTimeoutMs = DEFAULT_DRAIN_TIMEOUT_MS,
    abortGraceMs = ABORT_GRACE_MS,
    listenTimeoutMs = LISTEN_TIMEOUT_MS,
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
  /**
   * What a cancel wake-up does, for each request running here and for nothing else.
   *
   * This is the whole of the targeting. Every worker hears every cancel, so a wake-up naming a
   * request on another worker, or one that has already settled, finds nothing and costs no query.
   */
  const wakeups = new Map<string, () => void>();
  let stopped = false;
  let idle = Promise.resolve();

  /**
   * Whether something has happened since the last claim started that might make a request
   * claimable: a wake-up, or a turn of this worker's own finishing.
   *
   * A flag as well as a wake, because the thing it records can happen while a claim is in flight —
   * the claim read an empty queue, the request committed a moment later — and a loop that only
   * listened while asleep would then sleep straight through it.
   */
  let nudged = false;
  let wake: (() => void) | null = null;

  function nudge(): void {
    nudged = true;
    wake?.();
  }

  /** Set once the claim `LISTEN` has answered; read with the channel's own health on every rest. */
  let listeningForClaims = false;

  /**
   * One request, start to settled.
   *
   * Everything after the claim is inside the `finally`, because a request left `leased` by a
   * worker that walked away is invisible until its lease expires — a chat pane spinning on an
   * event that will never come.
   */
  async function run(request: LeasedTurnRequest): Promise<void> {
    const controller = new AbortController();
    running?.adopt(request.id, controller);
    controllers.add(controller);
    wakeups.set(request.id, () => {
      // Already stopping, so the row has nothing left to say and another click costs no query.
      if (!controller.signal.aborted) void renew(request, controller);
    });

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
      wakeups.delete(request.id);
      running?.release(request.id, controller);
    }
  }

  /** Whether the work succeeded. The runtime reports failure as a value; so does this. */
  async function execute(request: LeasedTurnRequest, signal: AbortSignal): Promise<boolean> {
    if (request.kind === "publish") {
      if (signal.aborted) return false;
      return (await options.publish?.(request, signal)) ?? false;
    }
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
        // Resume lifecycle events use this id. Any repair it starts records this request as
        // its owner while retaining its own turn id.
        turnId: request.id,
        lease: { requestId: request.id, owner },
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
      lease: { requestId: request.id, owner },
      ...(request.kind === "test"
        ? { kind: "test", jobId: request.message }
        : {
            message: request.message,
            ...(request.attachments === undefined ? {} : { attachments: request.attachments }),
            ...(request.plan === undefined ? {} : { plan: request.plan }),
          }),
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
   *
   * A cancel wake-up comes through here too rather than aborting for itself, so the row decides. A
   * notification about a request that was never flagged therefore stops nothing, and an extra
   * renewal is harmless: it pushes the lease out and answers the same question.
   */
  async function renew(request: LeasedTurnRequest, controller: AbortController): Promise<void> {
    try {
      const result = await queue.renew(request.id, owner);

      if (!result.held) {
        logger.warn(
          { requestId: request.id, sessionId: request.sessionId },
          "lease lost; aborting the turn",
        );
        if (controller.signal.reason instanceof TurnAbortError)
          controller.signal.reason.markLeaseLost();
        else controller.abort(new TurnAbortError("lease_lost"));
        return;
      }

      if (result.cancelRequested) controller.abort(new TurnAbortError("cancelled"));
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
        // A slot just came free, and the request queued behind this turn's session may just have
        // become claimable. Neither needs anybody else to say so.
        nudge();
      });
      inFlight.add(task);
    }
  }

  /**
   * The wait between two rounds: the fallback interval while wake-ups are being heard, the fast one
   * otherwise, and over at once if anything nudges it.
   */
  async function rest(): Promise<void> {
    if (nudged || stopped) return;
    const hearing = listeningForClaims && (options.claims?.hearing() ?? false);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, hearing ? fallbackPollIntervalMs : pollIntervalMs);
      function done(): void {
        clearTimeout(timer);
        wake = null;
        resolve();
      }
      wake = done;
    });
  }

  async function loop(): Promise<void> {
    while (!stopped) {
      // Before the claim rather than after it: anything from here on is something this claim may
      // have missed, so it has to send the loop straight round again.
      nudged = false;
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
      await rest();
    }
  }

  /**
   * Before the first claim, so every turn this worker takes is one a cancel can reach at once.
   *
   * A failure or a silence is a warning rather than a refusal to work: renewals still carry every
   * cancel, and a worker that cannot hear a wake-up is slower to stop a turn, which is no reason to
   * refuse to run one. A silence that ends is heard from then on, since the handler is already given.
   */
  const listening: Promise<StopListening | null> =
    options.cancels
      ?.listen((requestId) => wakeups.get(requestId)?.())
      .catch((error: unknown) => {
        logger.warn({ err: error }, "not hearing cancel wake-ups; a cancel waits for a renewal");
        return null;
      }) ?? Promise.resolve(null);

  /**
   * Not waited for before the first claim, unlike the cancel `LISTEN`: until it answers this worker
   * simply polls at the fast interval, so nothing enqueued meanwhile waits on it. Once it does, one
   * more claim covers whatever was announced before anybody here was listening.
   */
  const listeningToClaims: Promise<StopListening | null> =
    options.claims
      ?.listen(nudge)
      .then((stop) => {
        listeningForClaims = true;
        nudge();
        return stop;
      })
      .catch((error: unknown) => {
        logger.warn(
          { err: error },
          "not hearing claim wake-ups; polling the queue at the fast interval",
        );
        return null;
      }) ?? Promise.resolve(null);

  let startClaiming = () => {};
  const mayClaim = new Promise<void>((resolve) => {
    const patience = setTimeout(() => {
      logger.warn(
        { listenTimeoutMs },
        "no answer to LISTEN yet; claiming anyway, so a cancel waits for a renewal",
      );
      resolve();
    }, listenTimeoutMs);
    startClaiming = () => {
      clearTimeout(patience);
      resolve();
    };
  });
  void listening.then(startClaiming);

  idle = mayClaim.then(loop);

  /**
   * Bounded, because by now nothing is left for a wake-up to find and the wait could only cost the
   * caller's `process.exit` (see the end of `drain`). A `listen` still unanswered when this gives up
   * is stopped whenever it does answer, since this only gives up on waiting for that.
   */
  async function stopListening(): Promise<void> {
    const stopping = Promise.all([
      listening
        .then((stop) => stop?.())
        .catch((error: unknown) => {
          logger.warn({ err: error }, "could not stop listening for cancel wake-ups");
        }),
      listeningToClaims
        .then((stop) => stop?.())
        .catch((error: unknown) => {
          logger.warn({ err: error }, "could not stop listening for claim wake-ups");
        }),
    ]);

    let patience: ReturnType<typeof setTimeout> | undefined;
    const outOfPatience = new Promise<"expired">((resolve) => {
      patience = setTimeout(() => resolve("expired"), listenTimeoutMs);
    });

    const outcome = await Promise.race([stopping, outOfPatience]);
    clearTimeout(patience);
    if (outcome === "expired") logger.warn("gave up waiting to stop listening for wake-ups");
  }

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
      controller.abort(new TurnAbortError("shutdown"));
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
      startClaiming();
      // Out of whatever rest the loop is in, rather than waiting up to a fallback interval for it.
      nudge();
      await idle;
      await drain();
      // After the drain, because somebody can still press stop on a turn this is waiting for.
      await stopListening();
    },
  };
}
