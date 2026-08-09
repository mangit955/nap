import type { NapEvent, NapEventType } from "@nap/shared/events";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChatTranscript } from "./chat-transcript.tsx";

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

function show(...events: StoredEvent[]) {
  nextSeq = 1;
  return render(<ChatTranscript events={events} />);
}

/**
 * `docs/PLAN.md` §4 wants a defined visual treatment *and a test* for all eleven event types.
 * The table is the test: each row names something the reader must be able to find, so a type
 * that renders as nothing fails here, and a twelfth type fails to compile until it has a row.
 */
const TREATMENTS = [
  {
    type: "user.message",
    payload: { text: "build me a todo list" },
    shows: /build me a todo list/,
  },
  {
    type: "agent.message",
    payload: { text: "Added App.tsx." },
    shows: /Added App\.tsx\./,
  },
  {
    type: "agent.thinking",
    payload: { text: "weighing two layouts" },
    shows: /weighing two layouts/,
  },
  {
    type: "tool.call",
    payload: {
      toolCallId: "c1",
      toolName: "run_command",
      input: { command: "bun run build" },
    },
    shows: /bun run build/,
  },
  {
    type: "tool.result",
    payload: { toolCallId: "c1", toolName: "run_command", ok: false, output: "exit code 1" },
    shows: /exit code 1/,
  },
  {
    type: "command.output",
    payload: { toolCallId: "c1", stream: "stdout", chunk: "vite v8.0.0 ready" },
    shows: /vite v8\.0\.0 ready/,
  },
  {
    type: "file.changed",
    payload: { path: "src/App.tsx", changeType: "created", diff: "+one\n+two\n" },
    shows: /src\/App\.tsx/,
  },
  {
    type: "preview.ready",
    payload: { url: "https://5173-abc.e2b.dev", port: 5173 },
    shows: /preview/i,
  },
  { type: "turn.started", payload: {}, shows: /started/i },
  {
    type: "turn.completed",
    payload: {
      usage: { inputTokens: 1200, outputTokens: 340 },
      durationMs: 8400,
      commitSha: "a1b2c3d",
    },
    shows: /a1b2c3d/,
  },
  {
    type: "turn.failed",
    payload: { reason: "budget_exceeded", message: "step budget of 40 exceeded" },
    shows: /step budget of 40 exceeded/,
  },
] as const satisfies readonly { type: NapEventType; payload: NapEvent["payload"]; shows: RegExp }[];

describe("every event type has a visual treatment", () => {
  it("covers the whole union", () => {
    const covered = TREATMENTS.map((t) => t.type);
    expect(new Set(covered).size).toBe(covered.length);
    expect(TREATMENTS).toHaveLength(11);

    // Fails to compile if a 12th member is added to the union without a treatment.
    const _exhaustive: (typeof TREATMENTS)[number]["type"] = null as unknown as NapEventType;
    void _exhaustive;
  });

  it.each(TREATMENTS)("renders $type", ({ type, payload, shows }) => {
    show(ev(type, payload as never));

    expect(screen.getByRole("log")).toHaveTextContent(shows);
  });
});

describe("the transcript as a whole", () => {
  it("is a named log, so new events are announced rather than silently appearing", () => {
    show(ev("agent.message", { text: "done" }));

    expect(screen.getByRole("log", { name: /transcript/i })).toBeInTheDocument();
  });

  it("renders nothing but the log for an empty stream", () => {
    show();

    expect(screen.getByRole("log")).toBeEmptyDOMElement();
  });

  it("keeps events in the order they happened", () => {
    show(
      ev("user.message", { text: "first thing" }),
      ev("agent.message", { text: "second thing" }),
    );

    const log = screen.getByRole("log");
    const text = log.textContent ?? "";
    expect(text.indexOf("first thing")).toBeLessThan(text.indexOf("second thing"));
  });

  it("tells the two speakers apart", () => {
    // Without this a transcript is one voice, and "build me a todo list" reads as something
    // the agent said.
    show(ev("user.message", { text: "mine" }), ev("agent.message", { text: "theirs" }));

    // The speaker is announced, not only drawn — the visual difference is weight and colour,
    // which is nothing to someone listening.
    expect(screen.getByRole("log")).toHaveTextContent("You: mine");
    expect(screen.getByRole("log")).toHaveTextContent("Agent: theirs");
  });
});

describe("a turn in progress", () => {
  it("shows an unfinished tool call as running", () => {
    show(
      ev("turn.started", {}),
      ev("tool.call", {
        toolCallId: "c1",
        toolName: "run_command",
        input: { command: "bun run build" },
      }),
    );

    expect(screen.getByRole("log")).toHaveTextContent(/running/i);
  });

  it("stops calling it running once the result arrives", () => {
    show(
      ev("tool.call", {
        toolCallId: "c1",
        toolName: "run_command",
        input: { command: "bun run build" },
      }),
      ev("tool.result", {
        toolCallId: "c1",
        toolName: "run_command",
        ok: true,
        output: "exit code 0",
      }),
    );

    expect(screen.getByRole("log")).not.toHaveTextContent(/running/i);
  });

  it("gives the preview a link someone can open", () => {
    show(ev("preview.ready", { url: "https://5173-abc.e2b.dev", port: 5173 }));

    const link = screen.getByRole("link", { name: /5173-abc\.e2b\.dev/ });
    expect(link).toHaveAttribute("href", "https://5173-abc.e2b.dev");
    // The preview is the user's app on someone else's origin; it opens in its own tab.
    expect(link).toHaveAttribute("rel", expect.stringContaining("noreferrer"));
  });

  it("says a turn changed nothing rather than showing an empty commit", () => {
    show(
      ev("turn.completed", {
        usage: { inputTokens: 10, outputTokens: 5 },
        durationMs: 1200,
        commitSha: null,
      }),
    );

    expect(screen.getByRole("log")).toHaveTextContent(/no file changes/i);
  });

  it("names why a turn failed", () => {
    show(ev("turn.failed", { reason: "sandbox_unavailable", message: "could not resume" }));

    const log = screen.getByRole("log");
    expect(log).toHaveTextContent(/could not resume/);
    // The reason is a closed vocabulary the user should see in words, not a code.
    expect(log).toHaveTextContent(/sandbox/i);
  });
});
