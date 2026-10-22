import type { StoredEvent } from "@nap/shared/ports/event-store";
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ev } from "../testing/events.ts";
import { buildTranscript } from "./transcript.ts";
import { useTurnSubmission } from "./use-turn-submission.ts";
import { inFlightTurn } from "./working-state.ts";

const SESSION = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";
const COMPACT = "00000000-0000-4000-8000-000000000002";
const REQUEST = "00000000-0000-4000-8000-000000000003";
const NEXT = "00000000-0000-4000-8000-000000000004";
const accepted = (requestId = REQUEST) =>
  new Response(JSON.stringify({ accepted: true, requestId }), { status: 202 });
const status = (state: string, id = REQUEST) => new Response(JSON.stringify({ id, state }));
const manual = ev("compaction.started", { id: COMPACT, trigger: "manual" }, 1, { turnId: COMPACT });
const terminal = ev("turn.failed", { reason: "cancelled", message: "stopped" }, 2, {
  turnId: COMPACT,
});

afterEach(() => vi.useRealTimers());

it.each([false, true])(
  "reloads idle after a request's repair is recovered, start durable=%s",
  (started) => {
    const jobId = "00000000-0000-4000-8000-000000000005";
    const events = [
      ev("user.message", { text: "Build it" }, 1, { turnId: REQUEST }),
      ev(
        "turn.completed",
        { usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 1, commitSha: "abc" },
        2,
        { turnId: REQUEST },
      ),
      ev("user.message", { text: "Repair it", repair: { requestId: REQUEST, jobId } }, 3, {
        turnId: NEXT,
      }),
      ...(started ? [ev("turn.started", { source: "verification" }, 4, { turnId: NEXT })] : []),
      ev("turn.failed", { reason: "internal", message: "interrupted" }, 5, { turnId: NEXT }),
      ev("system.notice", { level: "warning", text: "Reopen" }, 6, { turnId: REQUEST }),
      // A delayed start from the same closed turn must not reopen it.
      ev("turn.started", { source: "verification" }, 7, { turnId: NEXT }),
    ];
    const fetchJson = vi.fn(async () => {
      throw new Error("no pending receipt to poll");
    });
    const hook = renderHook(() => useTurnSubmission({ sessionId: SESSION, events, fetchJson }));
    expect(hook.result.current.running).toBe(false);
    expect(hook.result.current.pending).toBeUndefined();
    expect(inFlightTurn(events)?.startedAt).toBeUndefined();
    expect(fetchJson).not.toHaveBeenCalled();
    hook.unmount();
  },
);

it.each([true, false])(
  "reconciles cancellation from another client, active compaction=%s",
  async (active) => {
    vi.useFakeTimers();
    let state = "queued";
    const fetchJson = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "POST" ? accepted() : status(state),
    );
    const hook = renderHook(
      (events: StoredEvent[]) => useTurnSubmission({ sessionId: SESSION, events, fetchJson }),
      { initialProps: active ? [manual] : [] },
    );
    await act(async () => {
      await hook.result.current.submit("Add the filter");
    });
    expect(hook.result.current.pending).toBe("Add the filter");
    state = "failed";
    if (active) hook.rerender([manual, terminal]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(hook.result.current.pending).toBeUndefined();
    expect(hook.result.current.running).toBe(false);
    expect(fetchJson).toHaveBeenCalledWith(
      expect.stringContaining(`/turns/${REQUEST}`),
      expect.anything(),
    );
  },
);

it("retains a prompt admitted after cancellation when the old compaction terminates", async () => {
  vi.useFakeTimers();
  const hook = renderHook(
    (events: StoredEvent[]) =>
      useTurnSubmission({
        sessionId: SESSION,
        events,
        fetchJson: async (_url, init) => (init?.method === "POST" ? accepted() : status("queued")),
      }),
    { initialProps: [manual] },
  );
  await act(async () => {
    await hook.result.current.submit("still wanted");
  });
  hook.rerender([manual, terminal]);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(hook.result.current.pending).toBe("still wanted");
  expect(hook.result.current.running).toBe(true);
});

it("correlates durable messages by accepted ID even if another client submits identical text", async () => {
  const hook = renderHook(
    (events: StoredEvent[]) =>
      useTurnSubmission({
        sessionId: SESSION,
        events,
        fetchJson: async (_url, init) => (init?.method === "POST" ? accepted() : status("queued")),
      }),
    { initialProps: [] as StoredEvent[] },
  );
  await act(async () => {
    await hook.result.current.submit("same text");
  });
  hook.rerender([ev("user.message", { text: "same text" }, 1, { turnId: NEXT })]);
  expect(hook.result.current.pending).toBe("same text");
  hook.rerender([ev("user.message", { text: "same text" }, 2, { turnId: REQUEST })]);
  await act(async () => {});
  expect(hook.result.current.pending).toBeUndefined();
});

it("reconciles events that arrived before the admission response and keeps Stop during manual preparation", async () => {
  let respond: (response: Response) => void = () => {};
  const response = new Promise<Response>((resolve) => {
    respond = resolve;
  });
  const fetchJson = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/cancel")) return new Response("{}", { status: 202 });
    return init?.method === "POST" ? response : status("leased", COMPACT);
  });
  const hook = renderHook(
    (events: StoredEvent[]) =>
      useTurnSubmission({
        sessionId: SESSION,
        events,
        fetchJson,
      }),
    { initialProps: [] as StoredEvent[] },
  );
  let posting: Promise<boolean> | undefined;
  act(() => {
    posting = hook.result.current.submit("/compact");
  });
  hook.rerender([manual]);
  await act(async () => {
    respond(accepted(COMPACT));
    await posting;
  });
  expect(hook.result.current.pending).toBeUndefined();
  expect(hook.result.current.running).toBe(true);
  expect(inFlightTurn([manual])?.startedAt).toBe(manual.createdAt);
  await act(async () => {
    await hook.result.current.cancel();
  });
  expect(fetchJson).toHaveBeenCalledWith(expect.stringContaining("/turns/cancel"), {
    method: "POST",
  });
  expect(hook.result.current.running).toBe(true);
  const history = [
    manual,
    ev("turn.started", { source: "user" }, 2, {
      turnId: COMPACT,
      createdAt: "2026-08-09T12:00:02.000Z",
    }),
    { ...manual, seq: 3, createdAt: "2026-08-09T12:00:03.000Z" },
  ];
  hook.rerender(history);
  expect(hook.result.current.running).toBe(true);
  expect(inFlightTurn(history)?.startedAt).toBe(manual.createdAt);
  hook.rerender([...history, { ...terminal, seq: 4 }]);
  expect(hook.result.current.running).toBe(false);
  expect(inFlightTurn([...history, { ...terminal, seq: 4 }])?.startedAt).toBeUndefined();
});

it("does not let an old cancel response clear a newer accepted prompt", async () => {
  let finishCancel: (response: Response) => void = () => {};
  const cancelled = new Promise<Response>((resolve) => {
    finishCancel = resolve;
  });
  let admitted = 0;
  const hook = renderHook(
    (events: StoredEvent[]) =>
      useTurnSubmission({
        sessionId: SESSION,
        events,
        fetchJson: async (url, init) => {
          if (url.endsWith("/cancel")) return cancelled;
          if (init?.method === "POST") return accepted(++admitted === 1 ? REQUEST : NEXT);
          return status("queued", url.endsWith(NEXT) ? NEXT : REQUEST);
        },
      }),
    { initialProps: [] as StoredEvent[] },
  );
  await act(async () => {
    await hook.result.current.submit("old");
  });
  let stopping: Promise<void> | undefined;
  act(() => {
    stopping = hook.result.current.cancel();
  });
  hook.rerender([
    ev("user.message", { text: "old" }, 1, { turnId: REQUEST }),
    ev("turn.failed", { reason: "cancelled", message: "stopped" }, 2, { turnId: REQUEST }),
  ]);
  await act(async () => {
    await hook.result.current.submit("new");
  });
  await act(async () => {
    finishCancel(new Response("{}", { status: 202 }));
    await stopping;
  });
  expect(hook.result.current.pending).toBe("new");
});

it("does not let an old status response clear a newer pending prompt", async () => {
  vi.useFakeTimers();
  let finishStatus: (response: Response) => void = () => {};
  const oldStatus = new Promise<Response>((resolve) => {
    finishStatus = resolve;
  });
  let admitted = 0;
  const hook = renderHook(
    (events: StoredEvent[]) =>
      useTurnSubmission({
        sessionId: SESSION,
        events,
        fetchJson: async (url, init) => {
          if (init?.method === "POST") return accepted(++admitted === 1 ? REQUEST : NEXT);
          return url.endsWith(REQUEST) ? oldStatus : status("queued", NEXT);
        },
      }),
    { initialProps: [] as StoredEvent[] },
  );
  await act(async () => {
    await hook.result.current.submit("old");
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  hook.rerender([
    ev("user.message", { text: "old" }, 1, { turnId: REQUEST }),
    ev("turn.failed", { reason: "cancelled", message: "stopped" }, 2, { turnId: REQUEST }),
  ]);
  await act(async () => {
    await hook.result.current.submit("new");
  });
  await act(async () => {
    finishStatus(status("failed"));
  });
  expect(hook.result.current.pending).toBe("new");
});

it("reloads an interrupted manual operation as its own retry without prior attachments", () => {
  const items = buildTranscript([
    ev(
      "user.message",
      {
        text: "old work",
        attachments: [
          {
            kind: "image",
            name: "old.jpg",
            frames: [{ timestamp: 0, mediaType: "image/jpeg", data: "AAAA" }],
          },
        ],
      },
      1,
      { turnId: REQUEST },
    ),
    ev("turn.failed", { reason: "sandbox_unavailable", message: "No capacity" }, 2, {
      turnId: REQUEST,
    }),
    { ...manual, seq: 3 },
    { ...terminal, seq: 4 },
  ]);
  expect(items.findLast((item) => item.kind === "turn-end")).toMatchObject({
    retryMessage: "/compact",
  });
  expect(items.findLast((item) => item.kind === "turn-end")).not.toHaveProperty("retryAttachments");
  expect(items.find((item) => item.kind === "compaction")).toMatchObject({ status: "failed" });
});

it.each(["completed", "failed"] as const)(
  "reloads a %s turn followed by a duplicate manual start as idle",
  (outcome) => {
    const end =
      outcome === "completed"
        ? ev(
            "turn.completed",
            {
              usage: { inputTokens: 1, outputTokens: 1 },
              durationMs: 10,
              commitSha: null,
            },
            2,
            { turnId: COMPACT },
          )
        : terminal;
    const history = [manual, end, { ...manual, seq: 3, createdAt: "2026-08-09T12:00:03.000Z" }];
    const hook = renderHook(() => useTurnSubmission({ sessionId: SESSION, events: history }));
    expect(hook.result.current.pending).toBeUndefined();
    expect(hook.result.current.running).toBe(false);
    expect(inFlightTurn(history)?.startedAt).toBeUndefined();
    if (outcome === "failed") {
      expect(buildTranscript(history).filter((item) => item.kind === "compaction")).toEqual([
        expect.objectContaining({ id: COMPACT, status: "failed" }),
      ]);
    }
  },
);

it.each(
  (["user", "verification", "manual"] as const).flatMap((source) =>
    [false, true].map((alreadyClosed) => ({ source, alreadyClosed })),
  ),
)(
  "keeps newer $source work active across old recovery events, alreadyClosed=$alreadyClosed",
  ({ source, alreadyClosed }) => {
    const preparation =
      source === "manual"
        ? ev("compaction.started", { id: NEXT, trigger: "manual" }, 3, {
            turnId: NEXT,
            createdAt: "2026-08-09T12:00:03.000Z",
          })
        : ev("user.message", { text: "new work" }, 3, { turnId: NEXT });
    const history = [manual, ...(alreadyClosed ? [terminal] : []), preparation];
    const hook = renderHook(
      (events: StoredEvent[]) => useTurnSubmission({ sessionId: SESSION, events }),
      { initialProps: history },
    );
    expect(hook.result.current.running).toBe(true);
    expect(inFlightTurn(history)?.startedAt).toBe(
      source === "manual" ? preparation.createdAt : undefined,
    );
    const started = ev("turn.started", { source: source === "manual" ? "user" : source }, 4, {
      turnId: NEXT,
      createdAt: "2026-08-09T12:00:04.000Z",
    });
    const active = [...history, started];
    const anchor = source === "manual" ? preparation.createdAt : started.createdAt;
    hook.rerender(active);
    expect(inFlightTurn(active)?.startedAt).toBe(anchor);
    const lateStart = { ...manual, seq: 5, createdAt: "2026-08-09T12:00:05.000Z" };
    const lateEnd = { ...terminal, seq: 6, createdAt: "2026-08-09T12:00:06.000Z" };
    for (const suffix of [[lateStart], [lateStart, lateEnd]]) {
      const replay = [...active, ...suffix];
      hook.rerender(replay);
      expect(hook.result.current.running).toBe(true);
      expect(inFlightTurn(replay)?.startedAt).toBe(anchor);
    }
    const closed = [
      ...active,
      lateStart,
      lateEnd,
      ev("turn.failed", { reason: "cancelled", message: "stopped" }, 7, { turnId: NEXT }),
      { ...manual, seq: 8 },
    ];
    hook.rerender(closed);
    expect(hook.result.current.running).toBe(false);
    expect(inFlightTurn(closed)?.startedAt).toBeUndefined();
  },
);

it.each(["completed", "failed"] as const)(
  "keeps an ordinary turn active after automatic compaction %s",
  (outcome) => {
    const started = ev("turn.started", { source: "user" }, 1, { turnId: NEXT });
    const compact = ev("compaction.started", { id: COMPACT, trigger: "automatic" }, 2, {
      turnId: NEXT,
      createdAt: "2026-08-09T12:00:02.000Z",
    });
    const end =
      outcome === "completed"
        ? ev(
            "compaction.completed",
            {
              id: COMPACT,
              result: {
                kind: "api",
                checkpoint: { summary: "saved", coveredThrough: 1, tail: [] },
              },
              usage: { inputTokens: 1, outputTokens: 1 },
              beforeTokens: 100,
              afterTokens: 10,
            },
            3,
            { turnId: NEXT },
          )
        : ev(
            "compaction.failed",
            {
              id: COMPACT,
              message: "unavailable",
              cancelled: false,
              usage: null,
            },
            3,
            { turnId: NEXT },
          );
    const hook = renderHook(
      (events: StoredEvent[]) => useTurnSubmission({ sessionId: SESSION, events }),
      { initialProps: [started, compact] },
    );
    expect(hook.result.current.running).toBe(true);
    expect(inFlightTurn([started, compact])?.startedAt).toBe(started.createdAt);
    hook.rerender([started, compact, end]);
    expect(hook.result.current.running).toBe(true);
    expect(inFlightTurn([started, compact, end])?.startedAt).toBe(started.createdAt);
    hook.rerender([started, compact, end, { ...terminal, seq: 4, turnId: NEXT }]);
    expect(hook.result.current.running).toBe(false);
  },
);
