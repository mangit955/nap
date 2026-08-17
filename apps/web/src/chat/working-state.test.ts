import type { NapEvent, NapEventType } from "@nap/shared/events";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { describe, expect, it } from "vitest";
import { buildTranscript } from "./transcript.ts";
import { stepTarget, turnStartedAt, workingLabel } from "./working-state.ts";

/**
 * A `.test.ts` under `apps/web`, like `transcript.test.ts` beside it: deriving what the agent
 * is doing right now is a pure fold over the same events, with no DOM in it, so it belongs to
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

const call = (id: string, toolName: "run_command" | "write_file" | "read_file", input: object) =>
  ev("tool.call", { toolCallId: id, toolName, input: input as Record<string, unknown> });

const result = (id: string, toolName: "run_command" | "write_file" | "read_file") =>
  ev("tool.result", { toolCallId: id, toolName, ok: true, output: "" });

/** The label as the pane computes it: fold the events, then read the fold. */
function labelFor(...events: StoredEvent[]): string {
  reset();
  return workingLabel(buildTranscript(events));
}

describe("workingLabel", () => {
  it("says what it is doing before anything has happened", () => {
    // The window between the click and `turn.started` arriving. `running` is already true —
    // the POST is in flight — so the indicator is on screen with nothing yet to describe.
    expect(labelFor()).toBe("Starting up");
  });

  it("names an open read by the file it is reading", () => {
    expect(
      labelFor(
        ev("turn.started", { source: "user" }),
        call("a", "read_file", { path: "src/App.tsx" }),
      ),
    ).toBe("Reading App.tsx");
  });

  it("strips the sandbox path, which is on every line and identifies nothing", () => {
    expect(
      labelFor(
        ev("turn.started", { source: "user" }),
        call("a", "write_file", { path: "/home/user/app/src/Counter.tsx" }),
      ),
    ).toBe("Writing Counter.tsx");
  });

  it("names an open command by the command", () => {
    expect(
      labelFor(
        ev("turn.started", { source: "user" }),
        call("a", "run_command", { command: "bun install" }),
      ),
    ).toBe("Running bun install");
  });

  it("falls back to thinking once every call has been answered", () => {
    expect(
      labelFor(
        ev("turn.started", { source: "user" }),
        call("a", "read_file", { path: "src/App.tsx" }),
        result("a", "read_file"),
      ),
    ).toBe("Thinking");
  });

  it("describes the last open call when several are running at once", () => {
    // Parallel tool use is on by default, so a single assistant message can open several
    // calls. Naming the first would leave the label stuck on a call that already returned.
    expect(
      labelFor(
        ev("turn.started", { source: "user" }),
        call("a", "read_file", { path: "src/App.tsx" }),
        call("b", "run_command", { command: "bun install" }),
      ),
    ).toBe("Running bun install");
  });

  it("goes back to thinking when the newer of two calls is answered", () => {
    expect(
      labelFor(
        ev("turn.started", { source: "user" }),
        call("a", "read_file", { path: "src/App.tsx" }),
        call("b", "run_command", { command: "bun install" }),
        result("b", "run_command"),
      ),
    ).toBe("Reading App.tsx");
  });

  it("thinks rather than starting up when the turn is open but has done nothing yet", () => {
    expect(labelFor(ev("turn.started", { source: "user" }))).toBe("Thinking");
  });
});

describe("stepTarget", () => {
  it("prefers the command, then the pattern, then the path", () => {
    reset();
    const items = buildTranscript([
      call("a", "run_command", { command: "bun test", path: "src/App.tsx" }),
    ]);
    const step = items[0];
    if (step?.kind !== "step") throw new Error("expected a step");

    expect(stepTarget(step)).toBe("bun test");
  });

  it("is empty for a call whose arguments this client never received", () => {
    reset();
    const items = buildTranscript([result("orphan", "read_file")]);
    const step = items[0];
    if (step?.kind !== "step") throw new Error("expected a step");

    expect(stepTarget(step)).toBe("");
  });
});

describe("turnStartedAt", () => {
  it("is undefined when no turn has started", () => {
    reset();
    expect(turnStartedAt([ev("agent.message", { text: "hello" })])).toBeUndefined();
  });

  it("is the timestamp the server wrote on the open turn", () => {
    reset();
    const started = ev("turn.started", { source: "user" });
    expect(turnStartedAt([started, ev("agent.thinking", { text: "…" })])).toBe(started.createdAt);
  });

  it("is undefined once that turn completed", () => {
    reset();
    expect(
      turnStartedAt([
        ev("turn.started", { source: "user" }),
        ev("turn.completed", {
          durationMs: 1200,
          usage: { inputTokens: 10, outputTokens: 2 },
          commitSha: null,
        }),
      ]),
    ).toBeUndefined();
  });

  it("is undefined once that turn failed", () => {
    reset();
    expect(
      turnStartedAt([
        ev("turn.started", { source: "user" }),
        ev("turn.failed", { reason: "sandbox_unavailable", message: "no sandbox" }),
      ]),
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
      ev("turn.started", { source: "user" }),
    ] as const;

    const answer = turnStartedAt([first, ...second]);
    expect(answer).toBe(second[1].createdAt);
    expect(answer).not.toBe(first.createdAt);
  });
});
