import type { NapEvent, NapEventType } from "@nap/shared/events";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { describe, expect, it } from "vitest";
import { inFlightTurn } from "./working-state.ts";

/**
 * A `.test.ts` under `apps/web`, like `transcript.test.ts` beside it: deriving which turn is
 * in flight is a pure fold over the same events, with no DOM in it, so it belongs to
 * the `unit` project. The component that renders the answer is `.test.tsx`.
 */

const SESSION = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";
const TURN = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";

let nextSeq = 1;
let clock = Date.parse("2026-08-09T12:00:00.000Z");

function ev<T extends NapEventType>(type: T, payload: Extract<NapEvent, { type: T }>["payload"]) {
  clock += 1000;
  return {
    type,
    sessionId: SESSION,
    turnId: TURN,
    seq: nextSeq++,
    createdAt: new Date(clock).toISOString(),
    payload,
  } as StoredEvent;
}

function reset() {
  nextSeq = 1;
  clock = Date.parse("2026-08-09T12:00:00.000Z");
}

describe("the in-flight turn's startedAt", () => {
  it("is undefined when no turn has started", () => {
    reset();
    expect(inFlightTurn([ev("agent.message", { text: "hello" })])?.startedAt).toBeUndefined();
  });

  it("is the timestamp the server wrote on the open turn", () => {
    reset();
    const started = ev("turn.started", { source: "user" });
    expect(inFlightTurn([started, ev("agent.thinking", { text: "…" })])?.startedAt).toBe(
      started.createdAt,
    );
  });

  it("is undefined once that turn completed", () => {
    reset();
    expect(
      inFlightTurn([
        ev("turn.started", { source: "user" }),
        ev("turn.completed", {
          durationMs: 1200,
          usage: { inputTokens: 10, outputTokens: 2 },
          commitSha: null,
        }),
      ])?.startedAt,
    ).toBeUndefined();
  });

  it("is undefined once that turn failed", () => {
    reset();
    expect(
      inFlightTurn([
        ev("turn.started", { source: "user" }),
        ev("turn.failed", { reason: "sandbox_unavailable", message: "no sandbox" }),
      ])?.startedAt,
    ).toBeUndefined();
  });

  it("ignores an earlier turn and answers with the one still open", () => {
    // A second turn in the same session. Anchoring the timer to the first would show an
    // elapsed time counting the gap between them, which is most of the number.
    reset();
    const first = ev("turn.started", { source: "user" });
    const second = [
      ev("turn.completed", {
        durationMs: 1200,
        usage: { inputTokens: 10, outputTokens: 2 },
        commitSha: null,
      }),
      { ...ev("turn.started", { source: "user" }), turnId: "8c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f" },
    ] as const;

    const answer = inFlightTurn([first, ...second])?.startedAt;
    expect(answer).toBe(second[1].createdAt);
    expect(answer).not.toBe(first.createdAt);
  });
});

it("retires only covered activity while retaining terminal identity across the idle boundary", () => {
  const first = ev("turn.started", { source: "user" });
  const ended = ev("turn.completed", {
    usage: { inputTokens: 1, outputTokens: 1 },
    durationMs: 1,
    commitSha: null,
  });
  const legacy = { ...ev("turn.started", { source: "verification" }), turnId: "legacy" };
  const duplicate = ev("turn.started", { source: "user" });
  const history = [first, ended, legacy, duplicate];
  expect(inFlightTurn(history, legacy.seq)).toBeUndefined();
  const newer = { ...ev("turn.started", { source: "verification" }), turnId: "newer" };
  expect(inFlightTurn([...history, newer], legacy.seq)).toEqual({
    turnId: newer.turnId,
    startedAt: newer.createdAt,
    openedAt: newer.createdAt,
  });
});

it("counts app test preparation as busy before the model starts and closes only its own turn", () => {
  const event = {
    type: "test.started" as const,
    sessionId: "s",
    turnId: "app-test",
    seq: 1,
    createdAt: "2026-10-24T00:00:00Z",
    payload: { jobId: "job", commitSha: "abcdef1", objective: "Save notes" },
  };
  expect(inFlightTurn([event])).toMatchObject({
    turnId: "app-test",
    openedAt: event.createdAt,
    startedAt: undefined,
  });
  expect(inFlightTurn([event], 1)).toBeUndefined();
});
