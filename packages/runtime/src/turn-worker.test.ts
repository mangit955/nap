import { PostgresCancelChannel } from "@nap/db/postgres-cancel-channel";
import { enqueueRequest } from "@nap/db/testing/enqueue-request";
import { NotifyHub } from "@nap/db/testing/in-memory-notify-transport";
import { InMemoryTurnQueue } from "@nap/db/testing/in-memory-turn-queue";
import { type Logger, setRootLogger } from "@nap/shared/logging";
import type { CancelChannel, StopListening } from "@nap/shared/ports/cancel-channel";
import type { ModelCredentials } from "@nap/shared/ports/llm-provider";
import type {
  ContinueOptions,
  ResumeOutcome,
  Runtime,
  TurnOutcome,
  TurnRequest,
} from "@nap/shared/ports/runtime";
import type { SteerQueue } from "@nap/shared/ports/steer-queue";
import type { LeasedTurnRequest, TurnQueue } from "@nap/shared/ports/turn-queue";
import { TurnAbortError } from "@nap/shared/turn-abort";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type RunningTurns, startTurnWorker, type TurnWorker } from "./turn-worker.ts";

/**
 * The worker loop against the in-memory queue.
 *
 * What is asserted here is what a worker *does* — claim, run, renew, abort, settle — and never the
 * rules the queue itself enforces, which are properties of a partial unique index and belong to
 * `postgres-turn-queue.db.test.ts`. The two intervals are turned down to single-digit
 * milliseconds, so a test waits for the loop rather than for a clock.
 *
 * **`vi.waitFor` rather than a fixed sleep**, throughout: the loop is a polling one, so anything
 * asserted immediately after an enqueue is asserted before it could possibly have happened.
 */

const POLL_MS = 2;
const RENEW_MS = 5;

const workers: TurnWorker[] = [];
const runtimes: RecordingRuntime[] = [];

afterEach(async () => {
  // `stop` waits for turns in flight, deliberately — so a test that left one hanging has to end
  // it, or the teardown waits forever rather than the assertion failing.
  for (const runtime of runtimes.splice(0)) runtime.completeAll();
  await Promise.all(workers.splice(0).map((worker) => worker.stop()));
});

/** A runtime whose turns hang until the test ends them, and that records what it was given. */
class RecordingRuntime implements Runtime {
  readonly turns: TurnRequest[] = [];
  readonly resumes: { sessionId: string; options: ContinueOptions }[] = [];
  #finish: ((outcome: TurnOutcome) => void)[] = [];
  #finishResume: ((outcome: ResumeOutcome) => void)[] = [];
  #throws = false;
  #deaf = false;

  constructor() {
    runtimes.push(this);
  }

  static throwing(): RecordingRuntime {
    const runtime = new RecordingRuntime();
    runtime.#throws = true;
    return runtime;
  }

  /** One that ignores its signal, which is the only way to produce a turn that will not stop. */
  static deaf(): RecordingRuntime {
    const runtime = new RecordingRuntime();
    runtime.#deaf = true;
    return runtime;
  }

  runTurn(request: TurnRequest): Promise<TurnOutcome> {
    this.turns.push(request);
    if (this.#throws) return Promise.reject(new Error("the runtime fell over"));

    return new Promise<TurnOutcome>((resolve) => {
      this.#finish.push(resolve);
      // A turn does not outlive its abort here, which is what makes the worker's own settlement
      // observable rather than something the test has to arrange.
      if (this.#deaf) return;
      request.signal?.addEventListener("abort", () => {
        resolve({ ok: false, turnId: "t1", reason: "cancelled", message: "aborted" });
      });
    });
  }

  /** Hangs like a turn does, because a resume that continues a job takes just as long. */
  resumeSession(sessionId: string, options: ContinueOptions): Promise<ResumeOutcome> {
    this.resumes.push({ sessionId, options });

    return new Promise<ResumeOutcome>((resolve) => {
      this.#finishResume.push(resolve);
      options.signal?.addEventListener("abort", () => {
        resolve({ ok: false, reason: "internal", message: "aborted" });
      });
    });
  }

  /** Ends the oldest turn still running. */
  complete(outcome: Partial<TurnOutcome> = {}): void {
    this.#finish.shift()?.({ ok: true, turnId: "t1", commitSha: null, ...outcome } as TurnOutcome);
  }

  /** Ends the oldest resume still running. */
  completeResume(): void {
    this.#finishResume.shift()?.({ ok: true, sandboxId: "sbx-1", created: true });
  }

  /** Ends everything still running, so a test's teardown is not waiting on any of it. */
  completeAll(): void {
    while (this.#finish.length > 0) this.complete();
    while (this.#finishResume.length > 0) this.completeResume();
  }

  get signal(): AbortSignal | undefined {
    return this.turns.at(-1)?.signal;
  }
}

function start(
  queue: TurnQueue,
  runtime: Runtime,
  overrides: {
    concurrency?: number;
    credentialsFor?: (userId: string) => Promise<ModelCredentials | null>;
    running?: RunningTurns;
    drainTimeoutMs?: number;
    abortGraceMs?: number;
    onClaimTick?: () => void;
    publish?: (request: LeasedTurnRequest, signal: AbortSignal) => Promise<boolean>;
    renewIntervalMs?: number;
    cancels?: Pick<CancelChannel, "listen">;
    listenTimeoutMs?: number;
    steers?: Pick<SteerQueue, "take" | "close">;
  } = {},
): TurnWorker {
  const worker = startTurnWorker({
    queue,
    runtime,
    owner: "worker-1",
    concurrency: overrides.concurrency ?? 1,
    pollIntervalMs: POLL_MS,
    renewIntervalMs: overrides.renewIntervalMs ?? RENEW_MS,
    ...(overrides.cancels === undefined ? {} : { cancels: overrides.cancels }),
    ...(overrides.listenTimeoutMs === undefined
      ? {}
      : { listenTimeoutMs: overrides.listenTimeoutMs }),
    ...(overrides.credentialsFor === undefined ? {} : { credentialsFor: overrides.credentialsFor }),
    ...(overrides.running === undefined ? {} : { running: overrides.running }),
    ...(overrides.drainTimeoutMs === undefined ? {} : { drainTimeoutMs: overrides.drainTimeoutMs }),
    ...(overrides.abortGraceMs === undefined ? {} : { abortGraceMs: overrides.abortGraceMs }),
    ...(overrides.onClaimTick === undefined ? {} : { onClaimTick: overrides.onClaimTick }),
    ...(overrides.publish === undefined ? {} : { publish: overrides.publish }),
    ...(overrides.steers === undefined ? {} : { steers: overrides.steers }),
  });
  workers.push(worker);
  return worker;
}

function enqueueTurn(
  queue: InMemoryTurnQueue,
  overrides: { sessionId?: string; message?: string; billsToUser?: boolean } = {},
) {
  return enqueueRequest(queue, {
    sessionId: overrides.sessionId ?? "session-a",
    userId: "user-1",
    kind: "turn",
    message: overrides.message ?? "build me a thing",
    model: "openai/gpt-5-mini",
    billsToUser: overrides.billsToUser ?? false,
  });
}

describe("running a claimed request", () => {
  it("publishes under a lease without opening model credentials or calling the runtime", async () => {
    const queue = new InMemoryTurnQueue();
    const runtime = new RecordingRuntime();
    const credentialsFor = vi.fn(async () => null);
    const publish = vi.fn(async () => true);
    const request = await enqueueRequest(queue, {
      sessionId: "session-a",
      userId: "user-1",
      kind: "publish",
      message: null,
      model: "unused",
      billsToUser: true,
    });
    start(queue, runtime, { credentialsFor, publish });
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    expect(publish).toHaveBeenCalledWith(
      expect.objectContaining({ id: request.id }),
      expect.any(AbortSignal),
    );
    expect(credentialsFor).not.toHaveBeenCalled();
    expect(runtime.turns).toEqual([]);
    expect(runtime.resumes).toEqual([]);
  });
  it("hands the runtime the prompt, the model and a signal", async () => {
    const queue = new InMemoryTurnQueue();
    const runtime = new RecordingRuntime();
    start(queue, runtime);
    await enqueueTurn(queue, { message: "make a todo list" });

    await vi.waitFor(() => expect(runtime.turns).toHaveLength(1));
    expect(runtime.turns[0]).toMatchObject({
      sessionId: "session-a",
      message: "make a todo list",
      model: "openai/gpt-5-mini",
    });
    expect(runtime.turns[0]?.signal).toBeInstanceOf(AbortSignal);
    // Nobody paid for this one themselves, so nothing was opened and nothing is passed.
    expect(runtime.turns[0]?.credentials).toBeUndefined();
  });

  it("hands a turn the steering of its own lease, and an app test none", async () => {
    const queue = new InMemoryTurnQueue();
    const runtime = new RecordingRuntime();
    start(queue, runtime, { steers: queue });
    const { id } = await enqueueTurn(queue);
    await vi.waitFor(() => expect(runtime.turns).toHaveLength(1));
    const steer = {
      id: crypto.randomUUID(),
      sessionId: "session-a",
      userId: "user-1",
      message: "use Postgres",
      model: "openai/gpt-5-mini",
      billsToUser: false,
    };
    await expect(queue.steer(steer)).resolves.toEqual({ as: "steer", requestId: id });

    const steering = runtime.turns[0]?.kind === "test" ? undefined : runtime.turns[0]?.steering;
    // Bound to this worker's lease: what it takes is this request's, and nobody else may.
    await expect(steering?.take()).resolves.toEqual([{ id: steer.id, text: "use Postgres" }]);
    await expect(steering?.close("defer")).resolves.toEqual({ deferred: [], dropped: [] });
    runtime.complete();

    await enqueueRequest(queue, {
      sessionId: "session-b",
      userId: "user-1",
      kind: "test",
      message: crypto.randomUUID(),
      model: "openai/gpt-5-mini",
      billsToUser: false,
    });
    await vi.waitFor(() => expect(runtime.turns).toHaveLength(2));
    expect(runtime.turns[1]?.steering).toBeUndefined();
  });

  it("runs the turn under the request's own id", async () => {
    // The identity of the work is allocated at admission and never re-invented here. Without this
    // the janitor could not close out a turn its worker died holding: the row would name one thing
    // and the events another, and nothing outside the dead process would know which.
    const queue = new InMemoryTurnQueue();
    const runtime = new RecordingRuntime();
    start(queue, runtime);
    const { id } = await enqueueTurn(queue);

    await vi.waitFor(() => expect(runtime.turns).toHaveLength(1));
    expect(runtime.turns[0]?.turnId).toBe(id);
  });

  it("runs a resume under the request's own id too", async () => {
    // Same rule, different kind: a resume may continue a job and write events of its own, so it
    // needs to be as nameable from outside as a turn is.
    const queue = new InMemoryTurnQueue();
    const runtime = new RecordingRuntime();
    start(queue, runtime);
    const { id } = await enqueueRequest(queue, {
      sessionId: "session-a",
      userId: "user-1",
      kind: "resume",
      message: null,
      model: "openai/gpt-5-mini",
      billsToUser: false,
    });

    await vi.waitFor(() => expect(runtime.resumes).toHaveLength(1));
    expect(runtime.resumes[0]?.options?.turnId).toBe(id);
  });

  it("settles the request done when the turn completes", async () => {
    const queue = new InMemoryTurnQueue();
    const runtime = new RecordingRuntime();
    start(queue, runtime);
    const { id } = await enqueueTurn(queue);

    await vi.waitFor(() => expect(runtime.turns).toHaveLength(1));
    runtime.complete();
    await vi.waitFor(() => expect(queue.stateOf(id)).toBe("done"));
  });

  it("settles the request failed when the turn fails", async () => {
    const queue = new InMemoryTurnQueue();
    const runtime = new RecordingRuntime();
    start(queue, runtime);
    const { id } = await enqueueTurn(queue);

    await vi.waitFor(() => expect(runtime.turns).toHaveLength(1));
    runtime.complete({ ok: false, reason: "internal", message: "no" } as Partial<TurnOutcome>);
    await vi.waitFor(() => expect(queue.stateOf(id)).toBe("failed"));
  });

  it("settles the request failed when the runtime throws", async () => {
    const queue = new InMemoryTurnQueue();
    start(queue, RecordingRuntime.throwing());
    const { id } = await enqueueTurn(queue);

    // A throw is a bug rather than a failed turn — but the row must still reach a terminal state,
    // or the session is held by a lease nothing will ever release.
    await vi.waitFor(() => expect(queue.stateOf(id)).toBe("failed"));
  });

  it("goes on to the next request once one has settled", async () => {
    const queue = new InMemoryTurnQueue();
    const runtime = new RecordingRuntime();
    start(queue, runtime);
    await enqueueTurn(queue, { message: "first" });
    await enqueueTurn(queue, { message: "second" });

    await vi.waitFor(() => expect(runtime.turns).toHaveLength(1));
    runtime.complete();
    await vi.waitFor(() => expect(runtime.turns).toHaveLength(2));
    expect(runtime.turns[1]?.message).toBe("second");
  });

  it("gives a resume the same signal a turn gets", async () => {
    // A resume that continues a job runs turns, so it answers to the lease exactly as a turn
    // does. Without this the controller the renewal aborts is wired to nothing on this branch,
    // and a worker that lost its lease mid-continuation would keep writing to the session.
    const queue = new InMemoryTurnQueue();
    const runtime = new RecordingRuntime();
    start(queue, runtime);
    const { id } = await enqueueRequest(queue, {
      sessionId: "session-a",
      userId: "user-1",
      kind: "resume",
      message: null,
      model: "openai/gpt-5-mini",
      billsToUser: false,
    });

    await vi.waitFor(() => expect(runtime.resumes).toHaveLength(1));
    const signal = runtime.resumes[0]?.options?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal?.aborted).toBe(false);

    queue.stealLease(id, "worker-2");
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
  });

  it("runs a resume through the runtime's resume path", async () => {
    const queue = new InMemoryTurnQueue();
    const runtime = new RecordingRuntime();
    start(queue, runtime);
    const { id } = await enqueueRequest(queue, {
      sessionId: "session-a",
      userId: "user-1",
      kind: "resume",
      message: null,
      model: "openai/gpt-5-mini",
      billsToUser: false,
    });

    await vi.waitFor(() => expect(runtime.resumes).toHaveLength(1));
    expect(runtime.resumes[0]?.sessionId).toBe("session-a");
    expect(runtime.turns).toHaveLength(0);
    runtime.completeResume();
    await vi.waitFor(() => expect(queue.stateOf(id)).toBe("done"));
  });

  it("never runs a resume beside a turn on the same session", async () => {
    // The two-sandbox failure in one test: a page that resumes on arrival while its user types a
    // message asks for both at once, and both create a sandbox when the project has none. The
    // lease is what makes the second wait, and a worker with room for both is the only way to
    // see it — concurrency 1 would serialise them for a reason that has nothing to do with it.
    const queue = new InMemoryTurnQueue();
    const runtime = new RecordingRuntime();
    start(queue, runtime, { concurrency: 4 });
    await enqueueTurn(queue, { sessionId: "session-a" });
    await enqueueRequest(queue, {
      sessionId: "session-a",
      userId: "user-1",
      kind: "resume",
      message: null,
      model: "openai/gpt-5-mini",
      billsToUser: false,
    });

    await vi.waitFor(() => expect(runtime.turns).toHaveLength(1));
    // Long enough for several poll intervals, so this is "it did not start" rather than "it had
    // not started yet".
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 10));
    expect(runtime.resumes).toHaveLength(0);

    runtime.complete();
    await vi.waitFor(() => expect(runtime.resumes).toHaveLength(1));
  });
});

describe("who pays", () => {
  it("opens the asker's key only when the request is billed to them", async () => {
    const queue = new InMemoryTurnQueue();
    const runtime = new RecordingRuntime();
    const asked: string[] = [];
    const credentials: ModelCredentials = { platform: "openrouter", apiKey: "sk-or-test" };
    start(queue, runtime, {
      credentialsFor: async (userId) => {
        asked.push(userId);
        return credentials;
      },
    });

    await enqueueTurn(queue, { message: "free one" });
    await vi.waitFor(() => expect(runtime.turns).toHaveLength(1));
    expect(asked).toEqual([]);
    runtime.complete();

    await enqueueTurn(queue, { message: "paid one", billsToUser: true });
    await vi.waitFor(() => expect(runtime.turns).toHaveLength(2));
    expect(asked).toEqual(["user-1"]);
    expect(runtime.turns[1]?.credentials).toEqual(credentials);
  });

  it("fails a billed request whose key can no longer be opened", async () => {
    const queue = new InMemoryTurnQueue();
    const runtime = new RecordingRuntime();
    start(queue, runtime, { credentialsFor: async () => null });
    const { id } = await enqueueTurn(queue, { billsToUser: true });

    // Running it anyway would bill this deployment for a turn somebody was admitted to on the
    // strength of paying for it themselves.
    await vi.waitFor(() => expect(queue.stateOf(id)).toBe("failed"));
    expect(runtime.turns).toHaveLength(0);
  });
});

describe("the lease", () => {
  it("aborts the turn as soon as a renewal says the lease is gone", async () => {
    const queue = new InMemoryTurnQueue();
    const runtime = new RecordingRuntime();
    start(queue, runtime);
    const { id } = await enqueueTurn(queue);

    await vi.waitFor(() => expect(runtime.turns).toHaveLength(1));
    expect(runtime.signal?.aborted).toBe(false);

    // What a janitor reclaiming an expired lease and another worker taking the session looks like
    // from inside a worker that is still alive and still writing. Without the self-abort this
    // process would keep appending to a session somebody else now owns.
    queue.stealLease(id, "worker-2");

    await vi.waitFor(() => expect(runtime.signal?.aborted).toBe(true));
    expect(runtime.signal?.reason).toMatchObject({ code: "lease_lost" });
  });

  it("leaves a lost request alone rather than settling somebody else's", async () => {
    const queue = new InMemoryTurnQueue();
    const runtime = new RecordingRuntime();
    start(queue, runtime);
    const { id } = await enqueueTurn(queue);

    await vi.waitFor(() => expect(runtime.turns).toHaveLength(1));
    queue.stealLease(id, "worker-2");
    await vi.waitFor(() => expect(runtime.signal?.aborted).toBe(true));

    // Still leased — by worker-2 as far as the queue is concerned. A zombie settling it would end
    // a turn that another worker may be running.
    await new Promise((resolve) => setTimeout(resolve, RENEW_MS * 4));
    expect(queue.stateOf(id)).toBe("leased");
  });

  it("survives a renewal that could not be asked at all", async () => {
    const queue = new InMemoryTurnQueue();
    const runtime = new RecordingRuntime();
    let failures = 0;
    const flaky: TurnQueue = {
      enqueue: (request) => queue.enqueue(request),
      getStatus: (request) => queue.getStatus(request),
      hasPending: (sessionId) => queue.hasPending(sessionId),
      claim: (owner) => queue.claim(owner),
      renew: async (requestId, owner) => {
        failures += 1;
        if (failures <= 2) throw new Error("the database blinked");
        return await queue.renew(requestId, owner);
      },
      settle: (requestId, owner, state) => queue.settle(requestId, owner, state),
      requestCancel: (sessionId) => queue.requestCancel(sessionId),
      anyLeased: (sessionIds) => queue.anyLeased(sessionIds),
      orphanExpired: (limit) => queue.orphanExpired(limit),
      unannouncedOrphans: (limit) => queue.unannouncedOrphans(limit),
      markOrphanAnnounced: (requestId) => queue.markOrphanAnnounced(requestId),
    };

    start(flaky, runtime);
    await enqueueTurn(queue);
    await vi.waitFor(() => expect(runtime.turns).toHaveLength(1));

    // A renewal that could not be *asked* is not a lease that was lost: the lease has several of
    // these to spare before it expires, and aborting on the first would make a blip cost every
    // turn in flight.
    await vi.waitFor(() => expect(failures).toBeGreaterThan(2));
    expect(runtime.signal?.aborted).toBe(false);
  });
});

describe("cancellation", () => {
  it("aborts a running turn within one renewal interval", async () => {
    const queue = new InMemoryTurnQueue();
    const runtime = new RecordingRuntime();
    start(queue, runtime);
    const { id } = await enqueueTurn(queue);

    await vi.waitFor(() => expect(runtime.turns).toHaveLength(1));
    expect(await queue.requestCancel("session-a")).toEqual({
      cancelled: true,
      was: "leased",
      requestId: id,
    });

    await vi.waitFor(() => expect(runtime.signal?.aborted).toBe(true));
    // Settled by this worker, which still holds the lease: cancelling asks it to stop, it does not
    // take the request away.
    await vi.waitFor(() => expect(queue.stateOf(id)).toBe("failed"));
  });

  it("never starts a request cancelled while it was queued", async () => {
    const queue = new InMemoryTurnQueue();
    const runtime = new RecordingRuntime();
    const { id } = await enqueueTurn(queue);
    await queue.requestCancel("session-a");

    start(queue, runtime);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 10));
    expect(runtime.turns).toHaveLength(0);
    expect(queue.stateOf(id)).toBe("failed");
  });
});

describe("a cancel wake-up", () => {
  /** Longer than any test here runs, so whatever stops a turn below is not a renewal. */
  const NEVER_MS = 600_000;
  /** How long to go on watching a turn that must not stop. Many polls of the loop. */
  const STILL_RUNNING_MS = POLL_MS * 15;

  /** Both halves of the channel, as one process announcing and another hearing. */
  function channel() {
    const hub = new NotifyHub();
    return {
      hub,
      worker: new PostgresCancelChannel(hub.connect()),
      api: new PostgresCancelChannel(hub.connect()),
    };
  }

  async function running(queue: InMemoryTurnQueue, runtime: RecordingRuntime, count = 1) {
    await vi.waitFor(() => expect(runtime.turns).toHaveLength(count));
    expect(runtime.signal?.aborted).toBe(false);
    return vi.spyOn(queue, "renew");
  }

  it("aborts the turn it names without waiting for a renewal", async () => {
    const queue = new InMemoryTurnQueue();
    const runtime = new RecordingRuntime();
    const { worker, api } = channel();
    start(queue, runtime, { cancels: worker, renewIntervalMs: NEVER_MS });
    const { id } = await enqueueTurn(queue);
    await running(queue, runtime);

    await queue.requestCancel("session-a");
    api.announce(id);

    await vi.waitFor(() => expect(runtime.signal?.aborted).toBe(true));
    expect(runtime.signal?.reason).toMatchObject({ code: "cancelled" });
    await vi.waitFor(() => expect(queue.stateOf(id)).toBe("failed"));
  });

  it("stops nothing when the row was never flagged, because the row is the cancel", async () => {
    const queue = new InMemoryTurnQueue();
    const runtime = new RecordingRuntime();
    const { worker, api } = channel();
    start(queue, runtime, { cancels: worker, renewIntervalMs: NEVER_MS });
    const { id } = await enqueueTurn(queue);
    const renew = await running(queue, runtime);

    api.announce(id);

    // It was heard — the worker went and asked — and the answer was to carry on.
    await vi.waitFor(() => expect(renew).toHaveBeenCalledWith(id, "worker-1"));
    await new Promise((resolve) => setTimeout(resolve, STILL_RUNNING_MS));
    expect(runtime.signal?.aborted).toBe(false);
  });

  it("costs nothing when it names a request running somewhere else", async () => {
    const queue = new InMemoryTurnQueue();
    const runtime = new RecordingRuntime();
    const { worker, api } = channel();
    start(queue, runtime, { cancels: worker, renewIntervalMs: NEVER_MS });
    await enqueueTurn(queue);
    const renew = await running(queue, runtime);

    api.announce(crypto.randomUUID());

    await new Promise((resolve) => setTimeout(resolve, STILL_RUNNING_MS));
    expect(renew).not.toHaveBeenCalled();
    expect(runtime.signal?.aborted).toBe(false);
  });

  it("does nothing to a session's next turn when it arrives late for the last one", async () => {
    // The shape that makes a wake-up name a request rather than a session. The first turn has
    // finished by the time this lands, and the same session is on to its next.
    const queue = new InMemoryTurnQueue();
    const runtime = new RecordingRuntime();
    const { worker, api } = channel();
    start(queue, runtime, { cancels: worker, renewIntervalMs: NEVER_MS });
    const first = await enqueueTurn(queue);
    await running(queue, runtime);
    runtime.complete();
    await vi.waitFor(() => expect(queue.stateOf(first.id)).toBe("done"));
    await enqueueTurn(queue);
    const renew = await running(queue, runtime, 2);

    api.announce(first.id);

    await new Promise((resolve) => setTimeout(resolve, STILL_RUNNING_MS));
    expect(renew).not.toHaveBeenCalled();
    expect(runtime.signal?.aborted).toBe(false);
  });

  it("still cancels at the next renewal when the wake-up is lost", async () => {
    const queue = new InMemoryTurnQueue();
    const runtime = new RecordingRuntime();
    const { hub, worker, api } = channel();
    start(queue, runtime, { cancels: worker, renewIntervalMs: POLL_MS * 20 });
    const { id } = await enqueueTurn(queue);
    await running(queue, runtime);

    hub.suppress();
    await queue.requestCancel("session-a");
    api.announce(id);

    expect(hub.sent).toBe(1);
    expect(runtime.signal?.aborted).toBe(false);
    await vi.waitFor(() => expect(runtime.signal?.aborted).toBe(true));
    expect(runtime.signal?.reason).toMatchObject({ code: "cancelled" });
  });

  it("finds out at once when the row says the lease has gone", async () => {
    // Told to look for one reason and learning another. Somebody else holds this request now, and
    // this worker aborts for that rather than for the cancel: what it just learned is that it is a
    // zombie, and the row's other answers are no longer its business.
    const queue = new InMemoryTurnQueue();
    const runtime = new RecordingRuntime();
    const { worker, api } = channel();
    start(queue, runtime, { cancels: worker, renewIntervalMs: NEVER_MS });
    const { id } = await enqueueTurn(queue);
    await running(queue, runtime);

    queue.stealLease(id, "worker-2");
    api.announce(id);

    await vi.waitFor(() => expect(runtime.signal?.aborted).toBe(true));
    expect(runtime.signal?.reason).toMatchObject({ code: "lease_lost" });
  });

  it("reaches a publication running under the same lease", async () => {
    const queue = new InMemoryTurnQueue();
    const runtime = new RecordingRuntime();
    const { worker, api } = channel();
    let seen: AbortSignal | undefined;
    const publish = (_request: LeasedTurnRequest, signal: AbortSignal) =>
      new Promise<boolean>((resolve) => {
        seen = signal;
        signal.addEventListener("abort", () => resolve(false));
      });
    start(queue, runtime, { cancels: worker, renewIntervalMs: NEVER_MS, publish });
    const { id } = await enqueueRequest(queue, {
      sessionId: "session-a",
      userId: "user-1",
      kind: "publish",
      message: null,
      model: "unused",
      billsToUser: false,
    });
    await vi.waitFor(() => expect(seen).toBeDefined());

    await queue.requestCancel("session-a");
    api.announce(id);

    await vi.waitFor(() => expect(seen?.aborted).toBe(true));
    await vi.waitFor(() => expect(queue.stateOf(id)).toBe("failed"));
  });

  it("asks nothing further once the turn is stopping", async () => {
    // Somebody pressing stop repeatedly on a turn slow to wind down, which is when they would.
    const queue = new InMemoryTurnQueue();
    const runtime = RecordingRuntime.deaf();
    const { worker, api } = channel();
    start(queue, runtime, { cancels: worker, renewIntervalMs: NEVER_MS });
    const { id } = await enqueueTurn(queue);
    const renew = await running(queue, runtime);

    await queue.requestCancel("session-a");
    api.announce(id);
    await vi.waitFor(() => expect(runtime.signal?.aborted).toBe(true));
    renew.mockClear();

    api.announce(id);
    api.announce(id);

    await new Promise((resolve) => setTimeout(resolve, STILL_RUNNING_MS));
    expect(renew).not.toHaveBeenCalled();
  });

  it("is still heard during a drain, and stops being heard after it", async () => {
    const queue = new InMemoryTurnQueue();
    const runtime = new RecordingRuntime();
    const { worker, api } = channel();
    const stopListening = vi.fn(async () => {});
    const draining = start(queue, runtime, {
      cancels: {
        listen: async (handler) => {
          const stop = await worker.listen(handler);
          return async () => {
            await stop();
            await stopListening();
          };
        },
      },
      renewIntervalMs: NEVER_MS,
      drainTimeoutMs: NEVER_MS,
    });
    const { id } = await enqueueTurn(queue);
    await running(queue, runtime);

    const stopped = draining.stop();
    await new Promise((resolve) => setTimeout(resolve, STILL_RUNNING_MS));
    expect(stopListening).not.toHaveBeenCalled();

    await queue.requestCancel("session-a");
    api.announce(id);

    await vi.waitFor(() => expect(runtime.signal?.aborted).toBe(true));
    await stopped;
    expect(stopListening).toHaveBeenCalledOnce();
  });

  it("claims nothing until it is listening", async () => {
    // A turn claimed first would be one a cancel could only reach at the next renewal.
    const queue = new InMemoryTurnQueue();
    const runtime = new RecordingRuntime();
    const { worker } = channel();
    let listen: () => void = () => {};
    const open = new Promise<void>((resolve) => {
      listen = resolve;
    });
    start(queue, runtime, {
      cancels: {
        listen: async (handler) => {
          await open;
          return await worker.listen(handler);
        },
      },
      renewIntervalMs: NEVER_MS,
    });
    await enqueueTurn(queue);

    await new Promise((resolve) => setTimeout(resolve, STILL_RUNNING_MS));
    expect(runtime.turns).toHaveLength(0);

    listen();
    await vi.waitFor(() => expect(runtime.turns).toHaveLength(1));
  });

  it("works on, with renewals carrying the cancel, when it cannot listen at all", async () => {
    const queue = new InMemoryTurnQueue();
    const runtime = new RecordingRuntime();
    start(queue, runtime, {
      cancels: { listen: () => Promise.reject(new Error("the listener is down")) },
    });
    await enqueueTurn(queue);
    await running(queue, runtime);

    await queue.requestCancel("session-a");

    await vi.waitFor(() => expect(runtime.signal?.aborted).toBe(true));
  });

  /**
   * A `LISTEN` written to a socket that has stopped answering, which postgres.js has no timeout for.
   * Nothing rejects, so a worker that only handled a failure would stop claiming and say nothing.
   */
  describe("when the LISTEN does not answer", () => {
    const PATIENCE_MS = POLL_MS * 5;
    const HUNG = { listen: () => new Promise<StopListening>(() => {}) };

    /** Every warning logged from here on. */
    function warnings(): string[] {
      const warned: string[] = [];
      const quiet = () => {};
      const logger: Logger = {
        debug: quiet,
        info: quiet,
        warn: (_fields: unknown, message?: string) => warned.push(message ?? ""),
        error: quiet,
        child: () => logger,
      };
      setRootLogger(logger);
      return warned;
    }

    /** Whether it finished, as an answer rather than as a test that times out in its teardown. */
    async function finishes(stopping: Promise<void>): Promise<boolean> {
      return await Promise.race([
        stopping.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2_000)),
      ]);
    }

    it("claims anyway, runs the turn to the end, and says what it did", async () => {
      const queue = new InMemoryTurnQueue();
      const runtime = new RecordingRuntime();
      const warned = warnings();
      start(queue, runtime, { cancels: HUNG, listenTimeoutMs: PATIENCE_MS });
      const { id } = await enqueueTurn(queue);

      await vi.waitFor(() => expect(runtime.turns).toHaveLength(1));
      expect(warned).toContainEqual(expect.stringMatching(/claiming anyway/));

      runtime.complete();
      await vi.waitFor(() => expect(queue.stateOf(id)).toBe("done"));
    });

    it("still stops a turn at its next renewal", async () => {
      const queue = new InMemoryTurnQueue();
      const runtime = new RecordingRuntime();
      start(queue, runtime, { cancels: HUNG, listenTimeoutMs: PATIENCE_MS });
      await enqueueTurn(queue);
      await running(queue, runtime);

      await queue.requestCancel("session-a");

      await vi.waitFor(() => expect(runtime.signal?.aborted).toBe(true));
    });

    it("gives up on nothing, and warns of nothing, when the answer comes in time", async () => {
      const queue = new InMemoryTurnQueue();
      const warned = warnings();
      const { worker } = channel();
      start(queue, new RecordingRuntime(), { cancels: worker, listenTimeoutMs: PATIENCE_MS });

      await new Promise((resolve) => setTimeout(resolve, PATIENCE_MS * 4));

      expect(warned).toEqual([]);
    });

    it("hears wake-ups from then on when the answer only comes late", async () => {
      const queue = new InMemoryTurnQueue();
      const runtime = new RecordingRuntime();
      const { worker, api } = channel();
      let answer: () => void = () => {};
      const answered = new Promise<void>((resolve) => {
        answer = resolve;
      });
      start(queue, runtime, {
        cancels: {
          listen: async (handler) => {
            await answered;
            return await worker.listen(handler);
          },
        },
        listenTimeoutMs: PATIENCE_MS,
        renewIntervalMs: NEVER_MS,
      });
      const { id } = await enqueueTurn(queue);
      await running(queue, runtime);

      answer();
      await new Promise((resolve) => setTimeout(resolve, STILL_RUNNING_MS));
      await queue.requestCancel("session-a");
      api.announce(id);

      await vi.waitFor(() => expect(runtime.signal?.aborted).toBe(true));
    });

    it("does not hold up stop(), and claims nothing on the way out", async () => {
      const queue = new InMemoryTurnQueue();
      const runtime = new RecordingRuntime();
      const warned = warnings();
      const worker = start(queue, runtime, { cancels: HUNG, listenTimeoutMs: PATIENCE_MS * 4 });
      await enqueueTurn(queue);

      expect(await finishes(worker.stop())).toBe(true);

      await new Promise((resolve) => setTimeout(resolve, PATIENCE_MS * 8));
      expect(runtime.turns).toHaveLength(0);
      // Stopping is what ended the wait. Sitting it out would say it is claiming while it is not.
      expect(warned.filter((message) => /claiming anyway/.test(message))).toEqual([]);
    });

    it("does not hold up stop() when it is the unlisten that does not answer", async () => {
      const worker = start(new InMemoryTurnQueue(), new RecordingRuntime(), {
        cancels: { listen: async () => () => new Promise<void>(() => {}) },
        listenTimeoutMs: PATIENCE_MS,
      });

      expect(await finishes(worker.stop())).toBe(true);
    });

    it("still stops a listen that answers after stop() has returned", async () => {
      const stopListening = vi.fn(async () => {});
      let answer: (stop: StopListening) => void = () => {};
      const worker = start(new InMemoryTurnQueue(), new RecordingRuntime(), {
        cancels: {
          listen: () =>
            new Promise<StopListening>((resolve) => {
              answer = resolve;
            }),
        },
        listenTimeoutMs: PATIENCE_MS,
      });

      expect(await finishes(worker.stop())).toBe(true);
      expect(stopListening).not.toHaveBeenCalled();

      answer(stopListening);

      await vi.waitFor(() => expect(stopListening).toHaveBeenCalledOnce());
    });

    it("reports an unlisten that fails, and stops anyway", async () => {
      const warned = warnings();
      const worker = start(new InMemoryTurnQueue(), new RecordingRuntime(), {
        cancels: { listen: async () => () => Promise.reject(new Error("the socket went away")) },
        listenTimeoutMs: PATIENCE_MS,
      });

      await expect(worker.stop()).resolves.toBeUndefined();

      expect(warned).toContainEqual(expect.stringMatching(/could not stop listening/));
    });

    it("reports a listen that fails late, rather than leaving a rejection nobody handled", async () => {
      const warned = warnings();
      const failing = {
        listen: () =>
          new Promise<StopListening>((_resolve, reject) => {
            setTimeout(() => reject(new Error("the listener is down")), PATIENCE_MS * 2);
          }),
      };
      start(new InMemoryTurnQueue(), new RecordingRuntime(), {
        cancels: failing,
        listenTimeoutMs: PATIENCE_MS,
      });

      await vi.waitFor(() =>
        expect(warned).toContainEqual(expect.stringMatching(/not hearing cancel wake-ups/)),
      );
    });
  });
});

describe("what else in this process is told", () => {
  it("announces a turn while it runs and releases it afterwards", async () => {
    const queue = new InMemoryTurnQueue();
    const runtime = new RecordingRuntime();
    const adopted: string[] = [];
    const released: string[] = [];
    const running: RunningTurns = {
      adopt: (requestId) => adopted.push(requestId),
      release: (requestId) => released.push(requestId),
    };
    start(queue, runtime, { running });
    const { id } = await enqueueTurn(queue);

    await vi.waitFor(() => expect(adopted).toEqual([id]));
    expect(released).toEqual([]);
    runtime.complete();
    await vi.waitFor(() => expect(released).toEqual([id]));
  });

  it("releases the turn even when the runtime throws", async () => {
    const queue = new InMemoryTurnQueue();
    const released: string[] = [];
    start(queue, RecordingRuntime.throwing(), {
      running: { adopt: () => {}, release: (requestId) => released.push(requestId) },
    });
    const { id } = await enqueueTurn(queue);

    // Otherwise the entry for it stays in this process's registry forever.
    await vi.waitFor(() => expect(released).toEqual([id]));
  });
});

describe("concurrency", () => {
  it("runs several sessions at once, up to its limit", async () => {
    const queue = new InMemoryTurnQueue();
    const runtime = new RecordingRuntime();
    start(queue, runtime, { concurrency: 2 });
    await enqueueTurn(queue, { sessionId: "session-a" });
    await enqueueTurn(queue, { sessionId: "session-b" });
    await enqueueTurn(queue, { sessionId: "session-c" });

    await vi.waitFor(() => expect(runtime.turns).toHaveLength(2));
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 10));
    expect(runtime.turns).toHaveLength(2);

    runtime.complete();
    await vi.waitFor(() => expect(runtime.turns).toHaveLength(3));
  });
});

describe("the claim tick", () => {
  // A worker has no port, so "is this process alive?" cannot be asked over HTTP: the only honest
  // question is whether the claim loop is still going round. A wedged loop leaves a pod that is
  // up, holds no leases and runs nothing — invisible to every other kind of probe.
  it("reports a tick even when the queue had nothing", async () => {
    const queue = new InMemoryTurnQueue();
    const runtime = new RecordingRuntime();
    let ticks = 0;
    start(queue, runtime, { onClaimTick: () => ticks++ });

    // The point of the assertion: nothing was enqueued, so a heartbeat driven by claimed work
    // would never fire and an idle worker would be restarted every two minutes.
    await vi.waitFor(() => expect(ticks).toBeGreaterThan(1));
  });

  it("reports a tick when claiming threw, because a database blip is not a wedged loop", async () => {
    const queue = new InMemoryTurnQueue();
    const runtime = new RecordingRuntime();
    let ticks = 0;
    vi.spyOn(queue, "claim").mockRejectedValue(new Error("the database is unreachable"));
    start(queue, runtime, { onClaimTick: () => ticks++ });

    await vi.waitFor(() => expect(ticks).toBeGreaterThan(1));
  });
});

describe("stopping", () => {
  it("stops claiming and waits for what is already running", async () => {
    const queue = new InMemoryTurnQueue();
    const runtime = new RecordingRuntime();
    const worker = start(queue, runtime);
    await enqueueTurn(queue, { sessionId: "session-a" });
    await vi.waitFor(() => expect(runtime.turns).toHaveLength(1));
    await enqueueTurn(queue, { sessionId: "session-b" });

    const stopping = worker.stop();
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });

    // A turn in flight holds a lease nothing else can take, and killing it would leave a Job open
    // for a human to continue when it was about to close on its own.
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 10));
    expect(stopped).toBe(false);
    expect(runtime.turns).toHaveLength(1);

    runtime.complete();
    await stopping;
    expect(runtime.turns).toHaveLength(1);
  });

  it("keeps renewing the leases of the turns it is draining", async () => {
    // The half of a drain nobody thinks to write down: a worker that stopped renewing while it
    // waited would have its own in-flight turns orphaned out from under it by the janitor, and
    // another worker would pick up a session this one is still writing to.
    const queue = new InMemoryTurnQueue();
    const runtime = new RecordingRuntime();
    let renewals = 0;
    const counting: TurnQueue = {
      enqueue: (request) => queue.enqueue(request),
      getStatus: (request) => queue.getStatus(request),
      hasPending: (sessionId) => queue.hasPending(sessionId),
      claim: (owner) => queue.claim(owner),
      renew: (requestId, owner) => {
        renewals += 1;
        return queue.renew(requestId, owner);
      },
      settle: (requestId, owner, state) => queue.settle(requestId, owner, state),
      requestCancel: (sessionId) => queue.requestCancel(sessionId),
      anyLeased: (sessionIds) => queue.anyLeased(sessionIds),
      orphanExpired: (limit) => queue.orphanExpired(limit),
      unannouncedOrphans: (limit) => queue.unannouncedOrphans(limit),
      markOrphanAnnounced: (requestId) => queue.markOrphanAnnounced(requestId),
    };

    const worker = start(counting, runtime, { drainTimeoutMs: 5_000 });
    await enqueueTurn(queue);
    await vi.waitFor(() => expect(runtime.turns).toHaveLength(1));

    const stopping = worker.stop();
    const before = renewals;
    await vi.waitFor(() => expect(renewals).toBeGreaterThan(before + 1));

    runtime.complete();
    await stopping;
  });

  it("aborts what is still running when the drain timeout expires", async () => {
    const queue = new InMemoryTurnQueue();
    const runtime = new RecordingRuntime();
    const worker = start(queue, runtime, { drainTimeoutMs: RENEW_MS * 4 });
    const { id } = await enqueueTurn(queue);
    await vi.waitFor(() => expect(runtime.turns).toHaveLength(1));

    // Nothing completes it: the platform is taking this process away and the turn is not going to
    // finish. An abort is a clean stop — the runtime commits nothing and closes its job — where
    // waiting forever would turn a rolling restart into a pod the platform has to kill.
    await worker.stop();

    expect(runtime.signal?.aborted).toBe(true);
    // And the row reaches a terminal state, so the session is not held by a lease whose worker
    // has exited and which only the janitor can now clear.
    expect(queue.stateOf(id)).toBe("failed");
  });

  it("gives up on a turn that ignores its abort, rather than never returning", async () => {
    // An abort is a request, and `stop()` is what stands between a graceful shutdown and SIGKILL:
    // a runtime that does not honour its signal would otherwise leave the caller's `process.exit`
    // waiting for ever, which is the exact ending the drain timeout exists to prevent.
    const queue = new InMemoryTurnQueue();
    const deaf = RecordingRuntime.deaf();
    const worker = start(queue, deaf, { drainTimeoutMs: 5, abortGraceMs: 20 });
    const { id } = await enqueueTurn(queue);
    await vi.waitFor(() => expect(deaf.turns).toHaveLength(1));

    await worker.stop();

    expect(deaf.signal?.aborted).toBe(true);
    // The request is still leased by a worker that is leaving, which is the janitor's case and the
    // reason it exists. Nothing here may settle it: this worker no longer knows what happened.
    expect(queue.stateOf(id)).toBe("leased");
  });

  it("does not abort a turn that finishes inside the drain window", async () => {
    const queue = new InMemoryTurnQueue();
    const runtime = new RecordingRuntime();
    const worker = start(queue, runtime, { drainTimeoutMs: 5_000 });
    const { id } = await enqueueTurn(queue);
    await vi.waitFor(() => expect(runtime.turns).toHaveLength(1));

    const stopping = worker.stop();
    runtime.complete();
    await stopping;

    expect(runtime.signal?.aborted).toBe(false);
    expect(queue.stateOf(id)).toBe("done");
  });
});

it("runs an app test under the normal lease using its approved job identity, model and cancellation", async () => {
  const queue = new InMemoryTurnQueue();
  const runtime = new RecordingRuntime();
  const jobId = crypto.randomUUID();
  const request = await enqueueRequest(queue, {
    kind: "test",
    message: jobId,
    sessionId: "app-test",
    userId: "user-1",
    model: "anthropic/claude-sonnet-5",
    billsToUser: false,
  });
  const worker = startTurnWorker({
    queue,
    runtime,
    concurrency: 1,
    pollIntervalMs: POLL_MS,
    renewIntervalMs: RENEW_MS,
  });
  workers.push(worker);
  await vi.waitFor(() => expect(runtime.turns).toHaveLength(1));
  expect(runtime.turns[0]).toMatchObject({
    kind: "test",
    jobId,
    turnId: request.id,
    model: "anthropic/claude-sonnet-5",
    signal: expect.any(AbortSignal),
  });
  expect(runtime.turns[0]?.message).toBeUndefined();
  await queue.requestCancel("app-test");
  await vi.waitFor(() => expect(runtime.turns[0]?.signal?.aborted).toBe(true));
});

it("updates authority loss while cancelled runtime cleanup is still draining", async () => {
  const queue = new InMemoryTurnQueue();
  const runtime = RecordingRuntime.deaf();
  start(queue, runtime);
  const { id } = await enqueueTurn(queue);
  await vi.waitFor(() => expect(runtime.turns).toHaveLength(1));
  // Use the actual claimed session, independent of the fixture's label.
  const sessionId = runtime.turns[0]?.sessionId;
  if (!sessionId) throw new Error("No turn was claimed.");
  await queue.requestCancel(sessionId);
  await vi.waitFor(() => expect(runtime.signal?.aborted).toBe(true));
  const reason = runtime.signal?.reason;
  if (!(reason instanceof TurnAbortError)) throw new Error("Missing structured abort reason.");
  queue.stealLease(id, "other-worker");
  await vi.waitFor(() => expect(reason.leaseLost).toBe(true));
  runtime.complete({ ok: false, reason: "cancelled", message: "cleanup finished" });
});
