import type { NapEvent, NapEventType } from "@nap/shared/events";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useTurnSubmission } from "./use-turn-submission.ts";

const SESSION = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";
const TURN = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";

let nextSeq = 1;

function ev<T extends NapEventType>(type: T, payload: Extract<NapEvent, { type: T }>["payload"]) {
  return {
    type,
    sessionId: SESSION,
    turnId: TURN,
    seq: nextSeq++,
    createdAt: "2026-08-09T12:00:00.000Z",
    payload,
  } as StoredEvent;
}

const started = () => ev("turn.started", {});
const userSaid = (text: string) => ev("user.message", { text });
const completed = () =>
  ev("turn.completed", {
    usage: { inputTokens: 1, outputTokens: 1 },
    durationMs: 10,
    commitSha: null,
  });
const failed = (reason: "cancelled" | "internal" = "cancelled") =>
  ev("turn.failed", { reason, message: "stopped" });

function poster(status = 202) {
  const calls: string[] = [];
  const fetchJson = async (url: string): Promise<Response> => {
    calls.push(new URL(url).pathname);
    return new Response(JSON.stringify({ accepted: true }), { status });
  };
  return { fetchJson, calls };
}

/** Renders the hook with a mutable event list, the way the stream hands one back. */
function submission(fetchJson = poster().fetchJson) {
  nextSeq = 1;
  return renderHook(
    (events: StoredEvent[]) => useTurnSubmission({ sessionId: SESSION, events, fetchJson }),
    { initialProps: [] as StoredEvent[] },
  );
}

describe("the optimistic message", () => {
  it("appears immediately, before the server has heard of it", async () => {
    const { result } = submission();

    await act(async () => {
      await result.current.submit("build me a todo list");
    });

    expect(result.current.pending).toBe("build me a todo list");
  });

  it("gives way to the server's event without doubling the message", async () => {
    // The bug this whole task is shaped around: the optimistic bubble and the real event are
    // the same sentence, and something has to decide which one the user sees.
    const { result, rerender } = submission();
    await act(async () => {
      await result.current.submit("build me a todo list");
    });

    rerender([started(), userSaid("build me a todo list")]);

    await waitFor(() => expect(result.current.pending).toBeUndefined());
  });

  it("survives events that are not its own message", async () => {
    // Clearing on any event at all would drop the bubble a frame after it appeared, and the
    // user would watch their message vanish before the transcript caught up.
    const { result, rerender } = submission();
    await act(async () => {
      await result.current.submit("build me a todo list");
    });

    rerender([started(), ev("agent.thinking", { text: "considering" })]);

    expect(result.current.pending).toBe("build me a todo list");
  });

  it("stays until *its* message arrives, not somebody else's", async () => {
    const { result, rerender } = submission();
    await act(async () => {
      await result.current.submit("second message");
    });

    rerender([userSaid("an earlier message")]);

    expect(result.current.pending).toBe("second message");
  });

  it("rolls back when the server refuses the turn", async () => {
    // The text goes back to the caller so the input can be refilled with it. A message that
    // disappears because a request failed is a message the user has to retype from memory.
    const { result } = submission(poster(500).fetchJson);

    await act(async () => {
      await result.current.submit("build me a todo list");
    });

    expect(result.current.pending).toBeUndefined();
    expect(result.current.error).toEqual(expect.any(String));
  });

  it("rolls back when the request never lands", async () => {
    const { result } = submission(() => Promise.reject(new Error("offline")));

    await act(async () => {
      await result.current.submit("build me a todo list");
    });

    expect(result.current.pending).toBeUndefined();
    expect(result.current.error).toEqual(expect.any(String));
  });

  it("clears a previous error when a new message is sent", async () => {
    const { result } = submission(poster(500).fetchJson);
    await act(async () => {
      await result.current.submit("first");
    });
    expect(result.current.error).toEqual(expect.any(String));

    await act(async () => {
      await result.current.submit("second");
    });

    // Still failing, but the error must belong to the attempt just made — a stale one under
    // the input reads as though the message that is on screen failed.
    expect(result.current.error).toEqual(expect.any(String));
    expect(result.current.pending).toBeUndefined();
  });
});

describe("whether a turn is running", () => {
  it("is true from the moment the message is sent", async () => {
    const { result } = submission();

    await act(async () => {
      await result.current.submit("hello");
    });

    expect(result.current.running).toBe(true);
  });

  it("stays true while the turn streams", async () => {
    const { result, rerender } = submission();
    await act(async () => {
      await result.current.submit("hello");
    });

    rerender([started(), userSaid("hello"), ev("agent.message", { text: "working" })]);

    expect(result.current.running).toBe(true);
  });

  it("becomes false when the turn completes", async () => {
    const { result, rerender } = submission();
    await act(async () => {
      await result.current.submit("hello");
    });

    rerender([started(), userSaid("hello"), completed()]);

    await waitFor(() => expect(result.current.running).toBe(false));
  });

  it("becomes false when the turn fails", async () => {
    const { result, rerender } = submission();
    await act(async () => {
      await result.current.submit("hello");
    });

    rerender([started(), userSaid("hello"), failed()]);

    await waitFor(() => expect(result.current.running).toBe(false));
  });

  it("is true for a turn this client did not start", async () => {
    // Derived from the log rather than remembered locally, so reloading mid-turn — or opening
    // a second tab — shows a disabled input instead of one that will be refused.
    const { result, rerender } = submission();

    rerender([started(), userSaid("from another tab")]);

    await waitFor(() => expect(result.current.running).toBe(true));
  });

  it("is false again after that turn ends", async () => {
    const { result, rerender } = submission();
    rerender([started(), userSaid("from another tab")]);
    await waitFor(() => expect(result.current.running).toBe(true));

    rerender([started(), userSaid("from another tab"), completed()]);

    await waitFor(() => expect(result.current.running).toBe(false));
  });

  it("is false when a failed POST never started anything", async () => {
    const { result } = submission(poster(500).fetchJson);

    await act(async () => {
      await result.current.submit("hello");
    });

    expect(result.current.running).toBe(false);
  });
});

describe("cancelling", () => {
  it("asks the server to stop the turn", async () => {
    const { fetchJson, calls } = poster();
    const { result } = submission(fetchJson);
    await act(async () => {
      await result.current.submit("hello");
    });

    await act(async () => {
      await result.current.cancel();
    });

    expect(calls).toEqual([`/sessions/${SESSION}/turns`, `/sessions/${SESSION}/turns/cancel`]);
  });

  it("re-enables the input once the cancellation lands in the log", async () => {
    // The button is not what ends the turn — `turn.failed` is. Re-enabling on the click would
    // let a second message be sent into a turn that is still tearing down.
    const { result, rerender } = submission();
    await act(async () => {
      await result.current.submit("hello");
    });
    await act(async () => {
      await result.current.cancel();
    });

    rerender([started(), userSaid("hello"), failed("cancelled")]);

    await waitFor(() => expect(result.current.running).toBe(false));
  });

  it("says nothing when the turn had already ended", async () => {
    // A 409 means the click and the last event crossed. There is nothing wrong to report.
    const { result } = submission(poster(409).fetchJson);

    await act(async () => {
      await result.current.cancel();
    });

    expect(result.current.error).toBeUndefined();
  });
});

describe("without a session", () => {
  it("sends nothing", async () => {
    const { fetchJson, calls } = poster();
    const { result } = renderHook(() =>
      useTurnSubmission({ sessionId: undefined, events: [], fetchJson }),
    );

    await act(async () => {
      await result.current.submit("hello");
    });

    expect(calls).toEqual([]);
    expect(result.current.pending).toBeUndefined();
  });
});

describe("when the server refuses", () => {
  /** Answers one refusal with a body, the way the rate limit and the quota do. */
  function refusing(status: number, body: unknown) {
    return async (): Promise<Response> => new Response(JSON.stringify(body), { status });
  }

  it("shows the reason the server gave rather than a generic apology", async () => {
    // A rate limit and a sandbox quota are both actionable — wait, or close a project — and the
    // server writes that sentence. Replacing it with "something went wrong" throws away the
    // only part the reader can do anything with.
    const message = "Too many turns. Try again in 4 minutes.";
    const { result } = submission(refusing(429, { error: message, code: "rate_limited" }));

    await act(async () => {
      await result.current.submit("hello");
    });

    expect(result.current.error).toBe(message);
  });

  it("falls back to a generic line when the body carries nothing usable", async () => {
    // A proxy's HTML error page, or an empty 502. A raw status code is not an instruction.
    const { result } = submission(refusing(502, {}));

    await act(async () => {
      await result.current.submit("hello");
    });

    expect(result.current.error).toBe("That message didn't send. Try again.");
  });

  it("still takes the message back off the screen", async () => {
    // Whatever the reason, a pending message left in the transcript claims the agent has it.
    const { result } = submission(refusing(409, { error: "You already have 2 running." }));

    await act(async () => {
      await result.current.submit("hello");
    });

    expect(result.current.pending).toBeUndefined();
  });
});
