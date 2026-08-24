import { describe, expect, it } from "vitest";
import type { JourneyClient, JourneyEvent, JourneyStream } from "./journey.ts";
import { runUserJourney } from "./journey.ts";
import { Metrics } from "./metrics.ts";

/**
 * A stream that hands over a fixed script of events, each with the moment it "arrived".
 *
 * The clock is the array index, not a real one: every latency this journey records is a
 * difference between two of these numbers, so a scripted clock is what makes the assertions
 * exact rather than approximate.
 */
function scriptedStream(events: JourneyEvent[]): JourneyStream & { closed: boolean } {
  const delivered: JourneyEvent[] = [];
  const stream = {
    closed: false,
    ready: async () => {},
    waitFor: async (types: readonly string[]) => {
      while (events.length > 0) {
        const next = events.shift() as JourneyEvent;
        delivered.push(next);
        if (types.includes(next.type)) return next;
      }
      throw new Error(`no ${types.join(" or ")} ever arrived`);
    },
    received: () => delivered,
    close: () => {
      stream.closed = true;
    },
  };
  return stream;
}

const HAPPY_EVENTS: JourneyEvent[] = [
  { seq: 1, type: "user.message", receivedAt: 110 },
  { seq: 2, type: "job.started", receivedAt: 120 },
  { seq: 3, type: "turn.started", receivedAt: 150 },
  { seq: 4, type: "agent.message", receivedAt: 400 },
  { seq: 5, type: "turn.completed", receivedAt: 900 },
  { seq: 6, type: "verification.completed", receivedAt: 950 },
  { seq: 7, type: "job.completed", receivedAt: 1_000 },
];

/** A clock that advances one tick per reading, so each step's stopwatch is distinguishable. */
function tickingClock(times: number[]): () => number {
  return () => times.shift() ?? 100;
}

function fakeClient(
  overrides: Partial<JourneyClient> & { stream?: JourneyStream } = {},
): JourneyClient {
  const stream = overrides.stream ?? scriptedStream([...HAPPY_EVENTS]);
  return {
    signIn: overrides.signIn ?? (async () => {}),
    createProject:
      overrides.createProject ?? (async () => ({ projectId: "p-1", sessionId: "s-1" })),
    openStream: overrides.openStream ?? (async () => stream),
    submitTurn: overrides.submitTurn ?? (async () => ({ status: 202 })),
  };
}

async function run(client: JourneyClient, metrics = new Metrics(), now?: () => number) {
  return await runUserJourney({
    client,
    metrics,
    message: "build a todo list",
    projectName: "load 1",
    ...(now === undefined ? {} : { now }),
  });
}

describe("runUserJourney", () => {
  it("completes the whole journey and reports the ids it created", async () => {
    const result = await run(fakeClient());

    expect(result).toEqual({
      ok: true,
      projectId: "p-1",
      sessionId: "s-1",
      seqs: [1, 2, 3, 4, 5, 6, 7],
    });
  });

  it("measures each wait from the right moment", async () => {
    const metrics = new Metrics();
    // sign-in start/end, project start/end, connect start/end, then the submission.
    await run(fakeClient(), metrics, tickingClock([0, 10, 10, 30, 30, 60, 100]));

    const { trends } = metrics.rollup();
    expect(trends.sign_in?.p50).toBe(10);
    expect(trends.create_project?.p50).toBe(20);
    expect(trends.ws_connect?.p50).toBe(30);
    // 202 → turn.started at 150, from a submission at 100.
    expect(trends.queue_wait?.p50).toBe(50);
    // The first frame after the submission is `user.message`, at 110.
    expect(trends.time_to_first_event?.p50).toBe(10);
    // turn.started at 150 → turn.completed at 900.
    expect(trends.turn_duration?.p50).toBe(750);
    // The submission at 100 → job.completed at 1000, which is longer than the turn.
    expect(trends.job_duration?.p50).toBe(900);
  });

  it("counts a clean stream as no gaps and no duplicates, and says so with zeroes", async () => {
    const metrics = new Metrics();
    await run(fakeClient(), metrics);

    const { counters, rates } = metrics.rollup();
    expect(counters.event_seq_gaps).toBe(0);
    expect(counters.event_duplicates).toBe(0);
    expect(counters.ws_connect_failures).toBe(0);
    expect(rates.turn_completion_rate).toEqual({ passed: 1, total: 1, rate: 1 });
    expect(rates.job_completion_rate).toEqual({ passed: 1, total: 1, rate: 1 });
  });

  it("counts a hole in the stream", async () => {
    const metrics = new Metrics();
    const gappy = HAPPY_EVENTS.filter((event) => event.seq !== 4);
    await run(fakeClient({ stream: scriptedStream(gappy) }), metrics);

    expect(metrics.rollup().counters.event_seq_gaps).toBe(1);
  });

  it("closes the socket even when the journey fails", async () => {
    const stream = scriptedStream([{ seq: 1, type: "user.message", receivedAt: 1 }]);
    const result = await run(fakeClient({ stream }));

    expect(result.ok).toBe(false);
    expect(stream.closed).toBe(true);
  });

  it("stops at a refused submission and records the category, not the status", async () => {
    const metrics = new Metrics();
    const result = await run(
      fakeClient({
        submitTurn: async () => ({ status: 409, code: "sandbox_quota_exceeded" }),
      }),
      metrics,
    );

    expect(result).toEqual({
      ok: false,
      step: "submit_turn",
      message: "the API answered 409 (sandbox_quota_exceeded)",
    });
    expect(metrics.rollup().counters.errors_sandbox_quota_exceeded).toBe(1);
    expect(metrics.rollup().rates.turn_completion_rate?.rate).toBe(0);
  });

  it("records a failed turn as a failed turn rather than a missing one", async () => {
    const metrics = new Metrics();
    const failing = [
      { seq: 1, type: "turn.started", receivedAt: 10 },
      { seq: 2, type: "turn.failed", receivedAt: 20 },
    ];
    const result = await run(fakeClient({ stream: scriptedStream(failing) }), metrics);

    expect(result).toEqual({ ok: false, step: "await_turn", message: "the turn failed" });
    const { rates } = metrics.rollup();
    expect(rates.turn_completion_rate).toEqual({ passed: 0, total: 1, rate: 0 });
    expect(rates.job_completion_rate).toEqual({ passed: 0, total: 1, rate: 0 });
  });

  it("counts a refused socket, and does not go on to submit a turn", async () => {
    const metrics = new Metrics();
    let submitted = 0;
    const result = await run(
      fakeClient({
        openStream: async () => {
          throw new Error("connection refused");
        },
        submitTurn: async () => {
          submitted += 1;
          return { status: 202 };
        },
      }),
      metrics,
    );

    expect(result).toEqual({ ok: false, step: "open_stream", message: "connection refused" });
    expect(metrics.rollup().counters.ws_connect_failures).toBe(1);
    expect(submitted).toBe(0);
  });

  it("stops at sign-in when the demo door is shut", async () => {
    const result = await run(
      fakeClient({
        signIn: async () => {
          throw new Error("404");
        },
      }),
    );

    expect(result).toEqual({ ok: false, step: "sign_in", message: "404" });
  });
});
