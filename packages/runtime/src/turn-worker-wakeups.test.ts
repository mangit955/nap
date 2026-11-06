import { PostgresClaimChannel } from "@nap/db/postgres-claim-channel";
import { enqueueRequest } from "@nap/db/testing/enqueue-request";
import { NotifyHub } from "@nap/db/testing/in-memory-notify-transport";
import { InMemoryTurnQueue } from "@nap/db/testing/in-memory-turn-queue";
import { type Logger, setRootLogger } from "@nap/shared/logging";
import type { ClaimChannel } from "@nap/shared/ports/claim-channel";
import type { ResumeOutcome, Runtime, TurnOutcome, TurnRequest } from "@nap/shared/ports/runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startTurnWorker, type TurnWorker } from "./turn-worker.ts";

/**
 * How often an idle worker asks the queue for work, and what makes it ask sooner.
 *
 * On a fake clock, because what is under test is a cadence: "at most one claim per fallback
 * interval" and "claimed in milliseconds rather than seconds" are both statements about time, and a
 * real clock would make the first take minutes and the second flaky. The other worker behaviour —
 * running, renewing, cancelling, draining — is `turn-worker.test.ts`'s.
 *
 * The fast interval is the production default and so is the fallback, so the numbers here are the
 * ones a deployment runs on.
 */

const FAST_MS = 100;
const FALLBACK_MS = 5_000;
/** Far shorter than either interval, so anything that happens inside it was not a poll. */
const PROMPTLY_MS = 10;

const workers: TurnWorker[] = [];
const runtimes: HangingRuntime[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  const quiet = () => {};
  const logger: Logger = {
    debug: quiet,
    info: quiet,
    warn: quiet,
    error: quiet,
    child: () => logger,
  };
  setRootLogger(logger);
});

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) runtime.completeAll();
  const stopping = Promise.all(workers.splice(0).map((worker) => worker.stop()));
  await vi.advanceTimersByTimeAsync(FALLBACK_MS * 2);
  await stopping;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** Turns that run until the test ends them. */
class HangingRuntime implements Runtime {
  readonly turns: TurnRequest[] = [];
  #finish: (() => void)[] = [];

  constructor() {
    runtimes.push(this);
  }

  runTurn(request: TurnRequest): Promise<TurnOutcome> {
    this.turns.push(request);
    return new Promise<TurnOutcome>((resolve) => {
      this.#finish.push(() =>
        resolve({ ok: true, turnId: request.turnId ?? "t", commitSha: null }),
      );
      request.signal?.addEventListener("abort", () => {
        resolve({ ok: false, turnId: "t", reason: "cancelled", message: "aborted" });
      });
    });
  }

  resumeSession(): Promise<ResumeOutcome> {
    return Promise.resolve({ ok: true, sandboxId: "sbx", created: false });
  }

  /** Ends the oldest turn still running. */
  complete(): void {
    this.#finish.shift()?.();
  }

  completeAll(): void {
    while (this.#finish.length > 0) this.complete();
  }
}

/** One process announcing and the hub standing in for the database between them. */
function channel(options: { hearing?: () => boolean } = {}) {
  const hub = new NotifyHub();
  return {
    hub,
    /** A worker's listening half. */
    listener: () => new PostgresClaimChannel(hub.connect(), options),
    /** Whatever wrote the row: the API at admission, or a worker settling. */
    announcer: new PostgresClaimChannel(hub.connect()),
  };
}

let workerCount = 0;

function start(
  queue: InMemoryTurnQueue,
  runtime: Runtime,
  overrides: {
    claims?: Pick<ClaimChannel, "listen" | "hearing">;
    concurrency?: number;
    onClaimTick?: () => void;
    owner?: string;
  } = {},
): TurnWorker {
  workerCount += 1;
  const worker = startTurnWorker({
    queue,
    runtime,
    owner: overrides.owner ?? `worker-${workerCount}`,
    concurrency: overrides.concurrency ?? 1,
    pollIntervalMs: FAST_MS,
    fallbackPollIntervalMs: FALLBACK_MS,
    // Never, inside any test here: a renewal is not what is being counted.
    renewIntervalMs: 600_000,
    ...(overrides.claims === undefined ? {} : { claims: overrides.claims }),
    ...(overrides.onClaimTick === undefined ? {} : { onClaimTick: overrides.onClaimTick }),
  });
  workers.push(worker);
  return worker;
}

function enqueueTurn(queue: InMemoryTurnQueue, sessionId = "session-a") {
  return enqueueRequest(queue, {
    sessionId,
    userId: "user-1",
    kind: "turn",
    message: "build me a thing",
    model: "openai/gpt-5-mini",
    billsToUser: false,
  });
}

/** Lets the worker settle into being idle, and lands between two of its fast polls. */
async function idle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1_050);
}

describe("an idle worker that can hear wake-ups", () => {
  it("asks the queue at most once per fallback interval", async () => {
    // The gap this exists to close: a loop asking every tenth of a second is ten transactions a
    // second per worker, for ever, against a database billed by the hour it is kept busy.
    const queue = new InMemoryTurnQueue();
    const claim = vi.spyOn(queue, "claim");
    start(queue, new HangingRuntime(), { claims: channel().listener() });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(claim.mock.calls.length).toBeLessThanOrEqual(60_000 / FALLBACK_MS + 2);
    // And it does still ask: the fallback is what a lost wake-up is caught by.
    expect(claim.mock.calls.length).toBeGreaterThanOrEqual(60_000 / FALLBACK_MS - 1);
  });

  it("claims an announced request at once, rather than at its next poll", async () => {
    const { listener, announcer } = channel();
    const queue = new InMemoryTurnQueue({ claims: announcer });
    const runtime = new HangingRuntime();
    start(queue, runtime, { claims: listener() });
    await idle();

    await enqueueTurn(queue);
    await vi.advanceTimersByTimeAsync(PROMPTLY_MS);

    expect(runtime.turns).toHaveLength(1);
  });

  it("does not lose a wake-up that lands while it is already asking", async () => {
    // The claim read an empty queue, and the request was enqueued before the answer came back. A
    // loop that only listened while asleep would sleep through it for the whole fallback interval.
    const { listener, announcer } = channel();
    const queue = new InMemoryTurnQueue({ claims: announcer });
    const runtime = new HangingRuntime();
    const claim = queue.claim.bind(queue);
    let release: (() => void) | null = null;
    vi.spyOn(queue, "claim").mockImplementation(async (owner) => {
      const answer = await claim(owner);
      if (release === null) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return answer;
    });
    start(queue, runtime, { claims: listener() });
    await vi.advanceTimersByTimeAsync(PROMPTLY_MS);
    expect(release).not.toBeNull();

    await enqueueTurn(queue);
    (release as unknown as () => void)();
    await vi.advanceTimersByTimeAsync(PROMPTLY_MS);

    expect(runtime.turns).toHaveLength(1);
  });

  it("still claims within the fallback interval when the wake-up is lost", async () => {
    // A NOTIFY sent while the listening socket is down is gone for good. That must cost a turn
    // seconds, never leave it queued for ever.
    const { hub, listener, announcer } = channel();
    const queue = new InMemoryTurnQueue({ claims: announcer });
    const runtime = new HangingRuntime();
    start(queue, runtime, { claims: listener() });
    await idle();
    hub.suppress();

    await enqueueTurn(queue);
    await vi.advanceTimersByTimeAsync(FALLBACK_MS + FAST_MS);

    expect(runtime.turns).toHaveLength(1);
  });

  it("goes on ticking its heartbeat on the fallback cadence", async () => {
    // The liveness probe restarts a worker whose loop has been silent for two minutes. An idle loop
    // that only came round when woken would be restarted every two minutes of quiet.
    const ticks: number[] = [];
    start(new InMemoryTurnQueue(), new HangingRuntime(), {
      claims: channel().listener(),
      onClaimTick: () => ticks.push(Date.now()),
    });

    await vi.advanceTimersByTimeAsync(60_000);

    const gaps = ticks.slice(1).map((at, index) => at - (ticks[index] ?? at));
    expect(ticks.length).toBeGreaterThanOrEqual(60_000 / FALLBACK_MS - 1);
    expect(Math.max(...gaps)).toBeLessThanOrEqual(FALLBACK_MS + FAST_MS);
  });

  it("stops without waiting out the fallback interval", async () => {
    const worker = start(new InMemoryTurnQueue(), new HangingRuntime(), {
      claims: channel().listener(),
    });
    await idle();

    let stopped = false;
    void worker.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(PROMPTLY_MS);

    expect(stopped).toBe(true);
  });
});

describe("work that becomes claimable without an enqueue", () => {
  it("claims the request queued behind its own turn as soon as that turn settles", async () => {
    // No announcer on the queue: a worker whose own turn just finished needs no network to know it
    // should ask again, and it has a free slot by construction.
    const queue = new InMemoryTurnQueue();
    const runtime = new HangingRuntime();
    await enqueueTurn(queue, "session-a");
    await enqueueTurn(queue, "session-a");
    start(queue, runtime, { claims: channel().listener(), concurrency: 2 });
    await idle();
    expect(runtime.turns).toHaveLength(1);

    runtime.complete();
    await vi.advanceTimersByTimeAsync(PROMPTLY_MS);

    expect(runtime.turns).toHaveLength(2);
  });

  it("claims the next request as soon as one of its turns finishes, when it was full", async () => {
    const queue = new InMemoryTurnQueue();
    const runtime = new HangingRuntime();
    await enqueueTurn(queue, "session-a");
    await enqueueTurn(queue, "session-b");
    start(queue, runtime, { claims: channel().listener(), concurrency: 1 });
    await idle();
    expect(runtime.turns).toHaveLength(1);

    runtime.complete();
    await vi.advanceTimersByTimeAsync(PROMPTLY_MS);

    expect(runtime.turns).toHaveLength(2);
  });

  it("wakes another worker when a draining one settles the turn a request was waiting on", async () => {
    // The draining worker will claim nothing more, so the request queued behind its turn is
    // somebody else's to take — and only the settle's own announcement tells them so.
    const { listener, announcer } = channel();
    const queue = new InMemoryTurnQueue({ claims: announcer });
    const runtime = new HangingRuntime();
    const leaving = start(queue, runtime, { claims: listener(), owner: "leaving" });
    await enqueueTurn(queue, "session-a");
    await vi.advanceTimersByTimeAsync(PROMPTLY_MS);
    expect(runtime.turns).toHaveLength(1);
    start(queue, runtime, { claims: listener(), owner: "staying" });
    await enqueueTurn(queue, "session-a");
    await idle();
    expect(runtime.turns).toHaveLength(1);

    // Not awaited here: the teardown does, so a worker that never stops fails an assertion below
    // rather than timing the test out.
    void leaving.stop();
    runtime.complete();
    await vi.advanceTimersByTimeAsync(PROMPTLY_MS);

    expect(runtime.turns).toHaveLength(2);
    expect(queue.computerLeases().map((row) => row.leaseOwner)).toEqual(["staying"]);
  });
});

describe("a worker that cannot hear wake-ups", () => {
  it.each([
    ["a LISTEN that fails", () => Promise.reject(new Error("no LISTEN for you"))],
    ["a LISTEN that never answers", () => new Promise<never>(() => {})],
  ])("polls at the fast interval after %s", async (_name, listen) => {
    // Degrading to the cadence it had before wake-ups existed, and no further.
    const queue = new InMemoryTurnQueue();
    const claim = vi.spyOn(queue, "claim");
    const runtime = new HangingRuntime();
    start(queue, runtime, { claims: { listen, hearing: () => true } });
    await idle();
    const before = claim.mock.calls.length;

    await vi.advanceTimersByTimeAsync(1_000);
    expect(claim.mock.calls.length - before).toBeGreaterThanOrEqual(1_000 / FAST_MS - 1);

    await enqueueTurn(queue);
    await vi.advanceTimersByTimeAsync(FAST_MS + PROMPTLY_MS);
    expect(runtime.turns).toHaveLength(1);
  });

  it("polls fast while the listener says it has gone deaf, and slows down once it hears again", async () => {
    let hearing = true;
    const queue = new InMemoryTurnQueue();
    const claim = vi.spyOn(queue, "claim");
    start(queue, new HangingRuntime(), { claims: channel({ hearing: () => hearing }).listener() });
    await vi.advanceTimersByTimeAsync(FALLBACK_MS * 2);

    hearing = false;
    // Up to one fallback interval for the sleep it was already in to end.
    await vi.advanceTimersByTimeAsync(FALLBACK_MS);
    let before = claim.mock.calls.length;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(claim.mock.calls.length - before).toBeGreaterThanOrEqual(1_000 / FAST_MS - 1);

    hearing = true;
    await vi.advanceTimersByTimeAsync(FAST_MS * 2);
    before = claim.mock.calls.length;
    await vi.advanceTimersByTimeAsync(FALLBACK_MS * 4);
    expect(claim.mock.calls.length - before).toBeLessThanOrEqual(5);
  });
});
