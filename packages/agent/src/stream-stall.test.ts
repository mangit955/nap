import Anthropic, { APIUserAbortError } from "@anthropic-ai/sdk";
import { InMemorySandboxManager } from "@nap/sandbox/testing/in-memory-sandbox-manager";
import type { AgentTurnRequest } from "@nap/shared/ports/agent-service";
import type { PendingEvent } from "@nap/shared/ports/event-store";
import type { LLMRequest } from "@nap/shared/ports/llm-provider";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_RETRY_DELAY_MS, NapAgentService } from "./agent-service.ts";
import {
  type AnthropicClient,
  type AnthropicMessage,
  ClaudeProvider,
  MAX_ATTEMPTS,
  STREAM_IDLE_TIMEOUT_MS,
  WORST_CASE_STALLED_CALL_MS,
} from "./claude-provider.ts";

/**
 * A model stream that stops talking.
 *
 * The SDK bounds only the wait for a response's headers; once the stream is open, a connection
 * that goes quiet is waited on for as long as the socket stays up. These pin the provider's own
 * idle window: what counts as the stream still being alive, that a quiet one is abandoned and
 * retried, that a cancel is never mistaken for one, and how long a model that stays quiet can
 * hold a turn. All on fake timers — nothing here waits in real time or reaches a network.
 */

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** What a scripted attempt can make its stream do while it is open. */
type Emitter = {
  event(raw: Anthropic.MessageStreamEvent): void;
  text(delta: string): void;
};

/** One attempt: given its stream, resolves to the assembled message whenever it chooses to. */
type Attempt = (emit: Emitter) => Promise<AnthropicMessage>;

/** A stream that never says anything again. */
const silent: Attempt = () => new Promise<AnthropicMessage>(() => {});

/** Waits on the faked clock, as a model's pauses do. */
const after = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A stub client whose streams stay open until their attempt resolves or their signal aborts,
 * rejecting the way the real SDK does on an abort: with `APIUserAbortError`, whoever aborted.
 * The stub cannot tell a stall from a cancel any more than the SDK can, which is the point —
 * the provider has to.
 */
function liveClient(attempts: Attempt[]) {
  const calls: { body: Anthropic.MessageStreamParams; signal: AbortSignal | undefined }[] = [];
  const client: AnthropicClient = {
    messages: {
      stream(body, options) {
        const attempt = attempts[calls.length];
        calls.push({ body, signal: options?.signal });
        if (attempt === undefined) throw new Error(`no attempt scripted for call ${calls.length}`);

        const listeners = new Map<string, ((first: never, snapshot: never) => void)[]>();
        const fire = (event: string, first: unknown, snapshot: unknown) => {
          for (const listener of listeners.get(event) ?? [])
            (listener as (first: unknown, snapshot: unknown) => void)(first, snapshot);
        };
        const emit: Emitter = {
          event: (raw) => fire("streamEvent", raw, message()),
          text: (delta) => fire("text", delta, delta),
        };
        const signal = options?.signal;
        const settled = new Promise<AnthropicMessage>((resolve, reject) => {
          if (signal?.aborted) return reject(new APIUserAbortError());
          signal?.addEventListener("abort", () => reject(new APIUserAbortError()), { once: true });
          // A turn later: the provider subscribes between `stream()` and `finalMessage()`.
          void Promise.resolve()
            .then(() => attempt(emit))
            .then(resolve, reject);
        });
        // Read by `finalMessage`, and never left unhandled when a test abandons the attempt.
        settled.catch(() => {});

        return {
          on(event: string, listener: (first: never, snapshot: never) => void) {
            listeners.set(event, [...(listeners.get(event) ?? []), listener]);
          },
          finalMessage: () => settled,
        };
      },
    },
  };
  return { client, calls };
}

function message(text = "done"): AnthropicMessage {
  return {
    content: [{ type: "text", text, citations: null }],
    stop_reason: "end_turn",
    usage: {
      input_tokens: 10,
      output_tokens: 4,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
    },
  } as AnthropicMessage;
}

const DELTA: Anthropic.MessageStreamEvent = {
  type: "content_block_delta",
  index: 0,
  delta: { type: "text_delta", text: "x" },
};

function request(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    systemPrompt: "you build apps",
    messages: [{ role: "user", content: "add a button" }],
    tools: [],
    ...overrides,
  };
}

/** Settles `work` on the faked clock, and says how long it took. */
async function timed<T>(work: Promise<T>, budgetMs: number): Promise<{ value: T; ms: number }> {
  const started = Date.now();
  let value: T | undefined;
  let done = false;
  void work.then((result) => {
    value = result;
    done = true;
  });
  // In steps, so the clock stops close to the moment the work settled rather than at the budget.
  for (let spent = 0; !done && spent <= budgetMs; spent += 500)
    await vi.advanceTimersByTimeAsync(500);
  if (!done) throw new Error(`still running after ${budgetMs}ms`);
  return { value: value as T, ms: Date.now() - started };
}

describe("a stream that goes quiet", () => {
  it("is abandoned after the idle window and tried again", async () => {
    const { client, calls } = liveClient([silent, async () => message("second time")]);
    const pending = new ClaudeProvider({ client }).startTurn().complete(request());

    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS - 1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(calls[0]?.signal?.aborted).toBe(true);

    const { value } = await timed(pending, 5_000);
    expect(value).toMatchObject({ type: "message", text: "second time" });
    expect(calls).toHaveLength(2);
  });

  it("is never abandoned while it keeps producing events, however long it runs", async () => {
    // A large file written out steadily: ten minutes of events, each well inside the window.
    const { client, calls } = liveClient([
      async (emit) => {
        for (let minute = 0; minute < 10; minute += 1) {
          await after(STREAM_IDLE_TIMEOUT_MS - 1_000);
          emit.event(DELTA);
        }
        return message("all of it");
      },
    ]);

    const { value } = await timed(
      new ClaudeProvider({ client }).startTurn().complete(request()),
      10 * STREAM_IDLE_TIMEOUT_MS,
    );

    expect(value).toMatchObject({ type: "message", text: "all of it" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.signal?.aborted).toBe(false);
  });

  it("reports a model that stayed quiet through every attempt as unavailable, and says why", async () => {
    const { client, calls } = liveClient(Array.from({ length: MAX_ATTEMPTS }, () => silent));

    const { value } = await timed(
      new ClaudeProvider({ client }).startTurn().complete(request()),
      WORST_CASE_STALLED_CALL_MS,
    );

    expect(value).toMatchObject({ type: "error", retryable: true });
    expect(value.type === "error" ? value.message : "").toMatch(/stopped responding/);
    expect(calls).toHaveLength(MAX_ATTEMPTS);
  });

  it("holds a call no longer than the documented bound", async () => {
    const { client } = liveClient(Array.from({ length: MAX_ATTEMPTS }, () => silent));

    const { ms } = await timed(
      new ClaudeProvider({ client }).startTurn().complete(request()),
      WORST_CASE_STALLED_CALL_MS + 5_000,
    );

    // The bound is the windows plus the waits between them, and it is reached, not merely kept
    // under: a bound nothing ever reaches is a sign the windows are not what this says they are.
    expect(ms).toBeLessThanOrEqual(WORST_CASE_STALLED_CALL_MS);
    expect(ms).toBeGreaterThan(WORST_CASE_STALLED_CALL_MS - 1_000);
  });
});

describe("the window, once the call is over", () => {
  it("is left armed behind no call, however it ended and whatever arrives late", async () => {
    // Counted before any time moves: a timer that has already fired is no longer counted, so
    // asserting after advancing would pass with the disarm deleted.
    let first: Emitter | undefined;
    const { client } = liveClient([
      async (emit) => {
        first = emit;
        return message();
      },
      silent,
      async () => message(),
    ]);
    const turn = new ClaudeProvider({ client }).startTurn();

    await turn.complete(request());
    // An event after the call is over, as a transport tearing down can still deliver one.
    first?.event(DELTA);
    expect(vi.getTimerCount()).toBe(0);

    const { value } = await timed(turn.complete(request()), STREAM_IDLE_TIMEOUT_MS + 5_000);
    expect(value.type).toBe("message");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("a cancel while the stream is quiet", () => {
  it("is called a cancel even when the window closes in the same moment", () => {
    // The stall's own abort and the person's arrive together: the SDK cannot say which ended the
    // stream, and the person asked for the work to stop, so that is what it was.
    const controller = new AbortController();
    const { client, calls } = liveClient([silent, silent, silent]);
    const pending = new ClaudeProvider({ client })
      .startTurn()
      .complete(request({ signal: controller.signal }));

    return Promise.resolve()
      .then(() => {
        vi.advanceTimersByTime(STREAM_IDLE_TIMEOUT_MS);
        controller.abort();
        return pending;
      })
      .then((value) => {
        expect(value).toMatchObject({ type: "error", retryable: false });
        expect(value.type === "error" ? value.message : "").not.toMatch(/stopped responding/);
        expect(calls).toHaveLength(1);
      });
  });

  it("ends the call at once, as a cancel, and never retries it", async () => {
    const controller = new AbortController();
    const { client, calls } = liveClient([silent, silent, silent]);
    const pending = new ClaudeProvider({ client })
      .startTurn()
      .complete(request({ signal: controller.signal }));

    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS / 3);
    controller.abort();
    const { value, ms } = await timed(pending, 1_000);

    expect(ms).toBeLessThan(1_000);
    expect(value).toMatchObject({ type: "error", retryable: false });
    expect(value.type === "error" ? value.message : "").not.toMatch(/stopped responding/);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.signal?.aborted).toBe(true);
  });
});

describe("what keeps a stream alive, on the real SDK", () => {
  /**
   * The SDK hides `ping` events from every listener — its SSE decoder skips them — and a model
   * that is thinking without a summary, or writing a tool call's arguments, sends nothing *but*
   * pings for as long as that takes. Counting only the events a listener sees would call that a
   * stall. These drive the real client over a fake `fetch`, so the bytes really do pass through
   * the SDK's decoder and the provider's watch on the response body.
   */
  const encoder = new TextEncoder();
  const frame = (event: string, data: unknown) =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const START = {
    type: "message_start",
    message: {
      id: "msg_1",
      type: "message",
      role: "assistant",
      model: "claude-opus-5",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 },
    },
  };
  const ANSWER = [
    frame("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }),
    frame("content_block_delta", {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "written" },
    }),
    frame("content_block_stop", { type: "content_block_stop", index: 0 }),
    frame("message_delta", {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    }),
    frame("message_stop", { type: "message_stop" }),
  ];

  /** A response that opens, sends `between` on its schedule, then answers — or never does. */
  function sseFetch(between: { everyMs: number; times: number }, answers: boolean) {
    let requests = 0;
    const fetch = async (_url: string | URL | Request, init?: RequestInit) => {
      requests += 1;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () =>
            controller.error(new DOMException("aborted", "AbortError")),
          );
          void (async () => {
            controller.enqueue(frame("message_start", START));
            for (let sent = 0; sent < between.times; sent += 1) {
              await after(between.everyMs);
              if (init?.signal?.aborted) return;
              controller.enqueue(frame("ping", { type: "ping" }));
            }
            if (!answers) return;
            for (const chunk of ANSWER) controller.enqueue(chunk);
            controller.close();
          })();
        },
      });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    };
    return { fetch, requests: () => requests };
  }

  it("counts a ping as the stream being alive, so a long silent stretch is not a stall", async () => {
    // Five minutes of nothing a listener can see — only pings, half a window apart.
    const transport = sseFetch({ everyMs: STREAM_IDLE_TIMEOUT_MS / 2, times: 10 }, true);
    const client = new Anthropic({ apiKey: "test", fetch: transport.fetch, maxRetries: 0 });

    const { value } = await timed(
      new ClaudeProvider({ client }).startTurn().complete(request()),
      10 * STREAM_IDLE_TIMEOUT_MS,
    );

    expect(value).toMatchObject({ type: "message", text: "written" });
    expect(transport.requests()).toBe(1);
  });

  it("abandons a real stream once even the pings stop", async () => {
    const transport = sseFetch({ everyMs: STREAM_IDLE_TIMEOUT_MS / 2, times: 2 }, false);
    const client = new Anthropic({ apiKey: "test", fetch: transport.fetch, maxRetries: 0 });
    const pending = new ClaudeProvider({ client }).startTurn().complete(request());

    // The last ping lands a full window after the stream opened; the stall is a window after it.
    await vi.advanceTimersByTimeAsync(2 * STREAM_IDLE_TIMEOUT_MS - 1);
    expect(transport.requests()).toBe(1);

    const { value } = await timed(pending, MAX_ATTEMPTS * 2 * STREAM_IDLE_TIMEOUT_MS);
    expect(value).toMatchObject({ type: "error", retryable: true });
    expect(value.type === "error" ? value.message : "").toMatch(/stopped responding/);
    expect(transport.requests()).toBe(MAX_ATTEMPTS);
  });
});

describe("a turn on a model that goes quiet", () => {
  let events: PendingEvent[];
  let manager: InMemorySandboxManager;
  let sandboxId: string;

  beforeEach(async () => {
    events = [];
    manager = new InMemorySandboxManager();
    const created = await manager.create("project");
    if (!created.ok) throw new Error(created.error.message);
    sandboxId = created.value.id;
  });

  function turn(overrides: Partial<AgentTurnRequest> = {}): AgentTurnRequest {
    return {
      sessionId: "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77",
      turnId: "7c9b1a52-8d3e-4f21-a0c4-1b2d3e4f5a6b",
      sandboxId,
      sandbox: manager,
      context: {
        systemPrompt: "You edit a React app.",
        messages: [{ role: "user", content: "Make it better." }],
        estimatedTokens: 10,
      },
      onEvent: (event) => events.push(event),
      ...overrides,
    };
  }

  const failed = () =>
    events.filter((event) => event.type === "turn.failed").map((event) => event.payload);

  it("writes nothing twice when the stream it was reading goes quiet", async () => {
    const { client, calls } = liveClient([
      async (emit) => {
        emit.text("Here is the plan. ");
        return new Promise<AnthropicMessage>(() => {});
      },
      async (emit) => {
        emit.text("Step one is the header.");
        return message("Step one is the header.");
      },
    ]);
    const agent = new NapAgentService({ provider: new ClaudeProvider({ client }) });

    await timed(agent.runTurn(turn()), STREAM_IDLE_TIMEOUT_MS + DEFAULT_RETRY_DELAY_MS + 5_000);

    const written = events
      .filter((event) => event.type === "agent.message")
      .map((event) => (event.payload as { text: string }).text)
      .join("");
    expect(written).toBe("Here is the plan. Step one is the header.");
    expect(calls[1]?.body.messages.at(-2)).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "Here is the plan. " }],
    });
    expect(events.at(-1)?.type).toBe("turn.completed");
  });

  it("is cancelled the moment it is cancelled, and says cancelled rather than unavailable", async () => {
    const controller = new AbortController();
    const { client } = liveClient([silent, silent, silent]);
    const agent = new NapAgentService({ provider: new ClaudeProvider({ client }) });
    const pending = agent.runTurn(turn({ signal: controller.signal }));

    await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS / 2);
    controller.abort();
    const { ms } = await timed(pending, 1_000);

    expect(ms).toBeLessThan(1_000);
    expect(failed()).toEqual([expect.objectContaining({ reason: "cancelled" })]);
  });

  it("gives up within the documented bound, having tried the fallback once", async () => {
    // Every attempt on every model stays quiet: the provider's attempts, the agent's one longer
    // wait and its attempts, then the fallback's attempts — and then the turn ends.
    const { client } = liveClient(Array.from({ length: 3 * MAX_ATTEMPTS }, () => silent));
    const provider = new ClaudeProvider({ client });
    const started = vi.spyOn(provider, "startTurn");
    const agent = new NapAgentService({ provider, fallbackModel: "openai/gpt-5.6-luna" });
    const bound = 3 * WORST_CASE_STALLED_CALL_MS + DEFAULT_RETRY_DELAY_MS;

    const { ms } = await timed(agent.runTurn(turn({ model: "anthropic/claude-opus-5" })), bound);

    expect(ms).toBeLessThanOrEqual(bound);
    expect(started.mock.calls.map(([options]) => options?.model)).toEqual([
      "anthropic/claude-opus-5",
      "openai/gpt-5.6-luna",
    ]);
    expect(failed()).toEqual([
      expect.objectContaining({
        reason: "model_unavailable",
        message: expect.stringMatching(/stopped responding/),
      }),
    ]);
  });
});
