import { type NapEvent, NapEventSchema, type NapEventType } from "@nap/shared/events";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ChatTranscript } from "./chat-transcript.tsx";
import { groupSteps } from "./step-group.ts";
import { REVEAL_CLASS } from "./streaming-text.tsx";
import { buildTranscript } from "./transcript.ts";

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

/**
 * The fold is applied here rather than inside the component, which is where the pane above
 * applies it too — it reads the same items for its working indicator, and two components folding
 * one log is two walks of it per frame of a streaming turn.
 */
function show(...events: StoredEvent[]) {
  nextSeq = 1;
  return render(<ChatTranscript items={groupSteps(buildTranscript(events))} />);
}

/**
 * Event types drawn by the job strip above the chat rather than by the transcript. Same list,
 * and same reasoning, as `transcript.test.ts` — a job's phase and its checks are status, not
 * chronology, and putting them in both panes says one thing twice.
 */
const DRAWN_ELSEWHERE = [
  "job.started",
  "verification.started",
  "verification.completed",
  "job.checkpointed",
  "job.completed",
] as const satisfies readonly NapEventType[];

/**
 * `docs/PLAN.md` §4 wants a defined visual treatment *and a test* for every event type the
 * transcript draws. The table is the test: each row names something the reader must be able to
 * find, so a type that renders as nothing fails here, and a new type fails to compile until it
 * has a row or a place above.
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
  { type: "preview.stopped", payload: {}, shows: /put away/i },
  { type: "turn.started", payload: {}, shows: /started/i },
  {
    type: "turn.completed",
    payload: {
      usage: { inputTokens: 1200, outputTokens: 340 },
      durationMs: 8400,
      commitSha: "a1b2c3d",
    },
    // The SHA and the token counts are gone from this row; the duration is what it says now.
    shows: /8\.4s/,
  },
  {
    type: "turn.failed",
    payload: { reason: "budget_exceeded", message: "step budget of 40 exceeded" },
    shows: /step budget of 40 exceeded/,
  },
  {
    type: "system.notice",
    payload: { level: "warning", text: "Could not restore your last snapshot." },
    shows: /Could not restore your last snapshot\./,
  },
] as const satisfies readonly { type: NapEventType; payload: NapEvent["payload"]; shows: RegExp }[];

describe("every event type has a visual treatment", () => {
  it("covers the whole union, between this pane and the strip", () => {
    const covered = TREATMENTS.map((t) => t.type);
    expect(new Set(covered).size).toBe(covered.length);
    expect(new Set([...covered, ...DRAWN_ELSEWHERE]).size).toBe(NapEventSchema.options.length);

    // Fails to compile if a new member is added to the union without a treatment here or a
    // place in `DRAWN_ELSEWHERE`.
    const _exhaustive: (typeof TREATMENTS)[number]["type"] | (typeof DRAWN_ELSEWHERE)[number] =
      null as unknown as NapEventType;
    void _exhaustive;
  });

  it("lets nothing but a job event out of the treatment table", () => {
    // The list is otherwise an escape hatch: a type moved into it renders nowhere while both
    // the count and the compile check stay green, which is what this table exists to catch.
    for (const type of DRAWN_ELSEWHERE) {
      expect(type).toMatch(/^(job|verification)\./);
      expect(TREATMENTS.map((t) => t.type)).not.toContain(type);
    }
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
      ev("turn.started", { source: "user" }),
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

  it("does not print the sandbox host into the transcript", () => {
    /*
     * The host is in the bar above, the bar has its own link to it, and the Preview tab is
     * showing the app — so a line saying "Preview ready · 5173-<random>.e2b.app" is the third
     * copy of something already on screen, and a restarted dev server adds another.
     *
     * Asserting on the class is the deliberate exception to the no-class-names rule, for the
     * same reason `file-viewer.test.tsx` has one: visually-hidden-ness has no accessible
     * surface, jsdom applies no stylesheet, and no role or text query can tell the two apart.
     * Without this, the next person restyling that arm puts the line back on screen.
     */
    show(ev("preview.ready", { url: "https://5173-abc.e2b.dev", port: 5173 }));

    expect(screen.getByText(/preview ready/i)).toHaveClass("sr-only");
  });

  it("still tells a screen reader the app is running, and where", () => {
    show(ev("preview.ready", { url: "https://5173-abc.e2b.dev", port: 5173 }));

    const link = screen.getByRole("link", { name: /5173-abc\.e2b\.dev/ });
    expect(link).toHaveAttribute("href", "https://5173-abc.e2b.dev");
    // The preview is the user's app on someone else's origin; it opens in its own tab.
    expect(link).toHaveAttribute("rel", expect.stringContaining("noreferrer"));
  });

  it("attributes a notice to the system rather than to the agent", () => {
    // The table row above only proves the text appears, which an agent-message treatment
    // would satisfy too. What matters is that nobody reads it as something the model said.
    show(ev("system.notice", { level: "warning", text: "Could not restore your last snapshot." }));

    const log = screen.getByRole("log");
    expect(log).toHaveTextContent(/warning/i);
    expect(log).not.toHaveTextContent(/agent:/i);
  });

  it("keeps the instrumentation out of the transcript", () => {
    // Token counts and a forty-character commit SHA are not something anybody reads between
    // turns, and the row carrying them was wide enough to give the whole pane a horizontal
    // scrollbar. Both are still in the event log for anything that wants them.
    show(
      ev("turn.completed", {
        usage: { inputTokens: 19909, outputTokens: 5569 },
        durationMs: 45_500,
        commitSha: "b3cf725b95b0b34198bf129e5ff430ac7e649c87",
      }),
    );

    const log = screen.getByRole("log");
    expect(log).toHaveTextContent(/45\.5s/);
    expect(log).not.toHaveTextContent(/19909/);
    expect(log).not.toHaveTextContent(/5569/);
    expect(log).not.toHaveTextContent(/b3cf725b/);
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

  it("names why a turn failed, in the user's vocabulary rather than the system's", () => {
    show(ev("turn.failed", { reason: "sandbox_unavailable", message: "could not resume" }));

    const log = screen.getByRole("log");
    // The server's own sentence survives — it is the part that distinguishes this failure from
    // the next one.
    expect(log).toHaveTextContent(/could not resume/);
    // "workspace", not "sandbox": this used to render the reason code's own wording, which
    // names the failure in the vocabulary of the thing that broke rather than of the person
    // reading it.
    expect(log).toHaveTextContent(/workspace/i);
    // And it says what to do, which is the whole point of the state existing.
    expect(log).toHaveTextContent(/send the message again/i);
  });
});

describe("reasoning arriving as it is produced", () => {
  const reveal = (container: HTMLElement) => container.querySelectorAll(`.${REVEAL_CLASS}`).length;

  it("reveals the last thing on the rail while the turn is open", () => {
    const { container } = show(
      ev("turn.started", { source: "user" }),
      ev("agent.thinking", { text: "I should read App.tsx" }),
    );

    expect(reveal(container)).toBeGreaterThan(0);
  });

  it("leaves everything above it alone", () => {
    // Only the newest item can still be growing. Re-revealing the ones above it would
    // replay the whole turn every time another word arrived.
    const { container } = show(
      ev("turn.started", { source: "user" }),
      ev("agent.thinking", { text: "an earlier thought" }),
      ev("agent.message", { text: "Added App.tsx." }),
      ev("agent.thinking", { text: "and a later one" }),
    );

    expect(reveal(container)).toBe("and a later one".split(" ").length);
  });

  it("replays a finished turn flat", () => {
    // Opening a project replays its whole log, and a transcript that re-ran every passage's
    // reveal would say the agent is working on a turn that ended yesterday. What prevents it
    // is that a finished turn ends *with* its terminal event, so the last line has no prose.
    const { container } = show(
      ev("turn.started", { source: "user" }),
      ev("agent.thinking", { text: "a thought from yesterday" }),
      ev("turn.completed", {
        usage: { inputTokens: 1, outputTokens: 1 },
        durationMs: 10,
        commitSha: null,
      }),
    );

    expect(reveal(container)).toBe(0);
    expect(screen.getByRole("log")).toHaveTextContent(/a thought from yesterday/);
  });

  it("reveals a passage in a log that begins mid-turn", () => {
    // What a client sees when it reconnects partway through: no `turn.started`, because that
    // event arrived before it asked. The turn is still running and the passage is still being
    // written, so treating a missing start as a finished turn would freeze it.
    const { container } = show(ev("agent.thinking", { text: "still thinking about this" }));

    expect(reveal(container)).toBeGreaterThan(0);
  });

  it("shows a run of thinking events as one passage", () => {
    show(
      ev("turn.started", { source: "user" }),
      ev("agent.thinking", { text: "I should read " }),
      ev("agent.thinking", { text: "App.tsx first." }),
    );

    expect(screen.getByText("I should read App.tsx first.")).toBeTruthy();
  });
});

describe("a project opened and closed many times", () => {
  const stop = () => ev("preview.stopped", {});
  const start = (host: string) =>
    ev("preview.ready", { url: `https://5173-${host}.e2b.app`, port: 5173 });

  it("draws one put-away line, not one per cycle", () => {
    // What this was: five identical "the project was put away" lines stacked in the transcript
    // after an afternoon of ordinary opening and closing — because a stop draws a full-width
    // line while the restart a few minutes later draws nothing visible at all. Five ordinary
    // events reading as five failures.
    show(stop(), start("a"), stop(), start("b"), stop());

    const lines = screen.getAllByText(/the project was put away/i);
    const visible = lines.filter((line) => !line.closest(".sr-only"));
    expect(visible).toHaveLength(1);
  });

  it("keeps every one of them in the log for a reader", () => {
    // The chronology is real and somebody listening to the transcript should still hear it —
    // the point is that it stops shouting, not that it forgets.
    show(stop(), start("a"), stop());

    expect(screen.getAllByText(/the project was put away/i)).toHaveLength(2);
  });

  it("says nothing at all once the project is back up", () => {
    show(stop(), start("a"));

    const visible = screen
      .getAllByText(/the project was put away/i)
      .filter((line) => !line.closest(".sr-only"));
    expect(visible).toEqual([]);
  });
});
