import { InMemoryTurnQueue } from "@nap/db/testing/in-memory-turn-queue";
import type { ModelCredentials } from "@nap/shared/ports/llm-provider";
import type {
  ContinueOptions,
  ResumeOutcome,
  Runtime,
  TurnOutcome,
  TurnRequest,
} from "@nap/shared/ports/runtime";
import type { TurnQueue } from "@nap/shared/ports/turn-queue";
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
  readonly resumes: { sessionId: string; options: ContinueOptions | undefined }[] = [];
  #finish: ((outcome: TurnOutcome) => void)[] = [];
  #finishResume: ((outcome: ResumeOutcome) => void)[] = [];
  #throws = false;

  constructor() {
    runtimes.push(this);
  }

  static throwing(): RecordingRuntime {
    const runtime = new RecordingRuntime();
    runtime.#throws = true;
    return runtime;
  }

  runTurn(request: TurnRequest): Promise<TurnOutcome> {
    this.turns.push(request);
    if (this.#throws) return Promise.reject(new Error("the runtime fell over"));

    return new Promise<TurnOutcome>((resolve) => {
      this.#finish.push(resolve);
      // A turn does not outlive its abort here, which is what makes the worker's own settlement
      // observable rather than something the test has to arrange.
      request.signal?.addEventListener("abort", () => {
        resolve({ ok: false, turnId: "t1", reason: "cancelled", message: "aborted" });
      });
    });
  }

  /** Hangs like a turn does, because a resume that continues a job takes just as long. */
  resumeSession(sessionId: string, options?: ContinueOptions): Promise<ResumeOutcome> {
    this.resumes.push({ sessionId, options });

    return new Promise<ResumeOutcome>((resolve) => {
      this.#finishResume.push(resolve);
      options?.signal?.addEventListener("abort", () => {
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
  } = {},
): TurnWorker {
  const worker = startTurnWorker({
    queue,
    runtime,
    owner: "worker-1",
    concurrency: overrides.concurrency ?? 1,
    pollIntervalMs: POLL_MS,
    renewIntervalMs: RENEW_MS,
    ...(overrides.credentialsFor === undefined ? {} : { credentialsFor: overrides.credentialsFor }),
    ...(overrides.running === undefined ? {} : { running: overrides.running }),
  });
  workers.push(worker);
  return worker;
}

function enqueueTurn(
  queue: InMemoryTurnQueue,
  overrides: { sessionId?: string; message?: string; billsToUser?: boolean } = {},
) {
  return queue.enqueue({
    sessionId: overrides.sessionId ?? "session-a",
    userId: "user-1",
    kind: "turn",
    message: overrides.message ?? "build me a thing",
    model: "openai/gpt-5-mini",
    billsToUser: overrides.billsToUser ?? false,
  });
}

describe("running a claimed request", () => {
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
    const { id } = await queue.enqueue({
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
    const { id } = await queue.enqueue({
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
      claim: (owner) => queue.claim(owner),
      renew: async (requestId, owner) => {
        failures += 1;
        if (failures <= 2) throw new Error("the database blinked");
        return await queue.renew(requestId, owner);
      },
      settle: (requestId, owner, state) => queue.settle(requestId, owner, state),
      requestCancel: (sessionId) => queue.requestCancel(sessionId),
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
    expect(await queue.requestCancel("session-a")).toEqual({ cancelled: true, was: "leased" });

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

describe("what else in this process is told", () => {
  it("announces a turn while it runs and releases it afterwards", async () => {
    const queue = new InMemoryTurnQueue();
    const runtime = new RecordingRuntime();
    const adopted: string[] = [];
    const released: string[] = [];
    const running: RunningTurns = {
      adopt: (sessionId) => adopted.push(sessionId),
      release: (sessionId) => released.push(sessionId),
    };
    start(queue, runtime, { running });
    await enqueueTurn(queue);

    await vi.waitFor(() => expect(adopted).toEqual(["session-a"]));
    expect(released).toEqual([]);
    runtime.complete();
    await vi.waitFor(() => expect(released).toEqual(["session-a"]));
  });

  it("releases the turn even when the runtime throws", async () => {
    const queue = new InMemoryTurnQueue();
    const released: string[] = [];
    start(queue, RecordingRuntime.throwing(), {
      running: { adopt: () => {}, release: (sessionId) => released.push(sessionId) },
    });
    await enqueueTurn(queue);

    // Otherwise the session stays "busy" in this process forever, and the reaper never puts its
    // project away.
    await vi.waitFor(() => expect(released).toEqual(["session-a"]));
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
});
