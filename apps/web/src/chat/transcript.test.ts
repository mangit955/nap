import type { NapEvent, NapEventType } from "@nap/shared/events";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { describe, expect, it } from "vitest";
import { buildTranscript, type TranscriptItem } from "./transcript.ts";

/**
 * A `.test.ts` under `apps/web`, on purpose: folding events into transcript items is a pure
 * function with no DOM in it, so it belongs to the `unit` project. The tests that render the
 * result are `.test.tsx` and run in jsdom.
 */

const SESSION = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";
const TURN = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";

let nextSeq = 1;

/** Builds a stored event, assigning `seq` the way the store would. */
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

function fold(...events: StoredEvent[]): TranscriptItem[] {
  nextSeq = 1;
  return buildTranscript(events);
}

const call = (id: string, toolName: "run_command" | "write_file" | "read_file", input: object) =>
  ev("tool.call", { toolCallId: id, toolName, input: input as Record<string, unknown> });

const result = (
  id: string,
  toolName: "run_command" | "write_file" | "read_file",
  ok: boolean,
  output: string,
) => ev("tool.result", { toolCallId: id, toolName, ok, output });

function stepsOf(items: TranscriptItem[]) {
  return items.flatMap((item) => (item.kind === "step" ? [item] : []));
}

/**
 * One case per event type. `docs/PLAN.md` §4 asks for a defined treatment for every one, so
 * the coverage is structural: a twelfth member of the union fails to compile here until it
 * has a case, rather than quietly rendering as nothing.
 */
const CASES = [
  { type: "user.message", payload: { text: "build me a todo list" } },
  { type: "agent.thinking", payload: { text: "considering the layout" } },
  { type: "agent.message", payload: { text: "Added App.tsx." } },
  {
    type: "tool.call",
    payload: { toolCallId: "c1", toolName: "read_file", input: { path: "/home/user/app/x.tsx" } },
  },
  {
    type: "tool.result",
    payload: { toolCallId: "c1", toolName: "read_file", ok: true, output: "contents" },
  },
  {
    type: "file.changed",
    payload: { path: "src/App.tsx", changeType: "modified", diff: "@@ -1 +1 @@\n-a\n+b\n" },
  },
  {
    type: "command.output",
    payload: { toolCallId: "c1", stream: "stdout", chunk: "building…\n" },
  },
  { type: "preview.ready", payload: { url: "https://5173-abc.e2b.dev", port: 5173 } },
  { type: "preview.stopped", payload: {} },
  { type: "turn.started", payload: {} },
  {
    type: "turn.completed",
    payload: {
      usage: { inputTokens: 1200, outputTokens: 340 },
      durationMs: 8400,
      commitSha: "a1b2c3d",
    },
  },
  { type: "turn.failed", payload: { reason: "refusal", message: "declined" } },
  {
    type: "system.notice",
    payload: { level: "warning", text: "Could not restore your last snapshot." },
  },
] as const satisfies readonly { type: NapEventType; payload: NapEvent["payload"] }[];

describe("the treatment table covers the union", () => {
  it("has one case per event type", () => {
    const covered = CASES.map((c) => c.type);
    expect(new Set(covered).size).toBe(covered.length);
    expect(CASES).toHaveLength(13);

    // Fails to compile if a 14th member is added to the union without a case here.
    const _exhaustive: (typeof CASES)[number]["type"] = null as unknown as NapEventType;
    void _exhaustive;
  });

  it.each(CASES)("folds $type into something renderable", ({ type, payload }) => {
    const items = fold(ev(type, payload as never));

    // Every event has to leave a trace. An event that folds to nothing is an event the user
    // never learns about, which for `turn.failed` or a failed tool is the worst outcome.
    expect(items.length).toBeGreaterThan(0);
  });
});

describe("messages", () => {
  it("keeps user and agent prose apart and in order", () => {
    const items = fold(
      ev("user.message", { text: "build me a todo list" }),
      ev("agent.message", { text: "Added App.tsx." }),
    );

    expect(items.map((i) => i.kind)).toEqual(["message", "message"]);
    expect(items).toMatchObject([
      { from: "user", text: "build me a todo list" },
      { from: "agent", text: "Added App.tsx." },
    ]);
  });

  it("keeps thinking separate from what the agent said", () => {
    const items = fold(
      ev("agent.thinking", { text: "considering the layout" }),
      ev("agent.message", { text: "Added App.tsx." }),
    );

    expect(items.map((i) => i.kind)).toEqual(["thinking", "message"]);
  });

  it("folds a run of thinking events into one passage", () => {
    // The agent's reasoning arrives coalesced into phrase-sized events, several a second.
    // One paragraph per event would break a single thought across a dozen blocks.
    const items = fold(
      ev("agent.thinking", { text: "I should read " }),
      ev("agent.thinking", { text: "App.tsx first." }),
    );

    expect(items).toEqual([{ kind: "thinking", key: 1, text: "I should read App.tsx first." }]);
  });

  it("keys the passage to where it began", () => {
    // The key is what React renders the passage under, and the passage grows on every frame
    // while the model thinks. A key that moved with the newest event would remount the
    // element each time, restarting the reveal of every word already on screen.
    const [first] = fold(ev("agent.thinking", { text: "one" }));
    const [grown] = fold(
      ev("agent.thinking", { text: "one" }),
      ev("agent.thinking", { text: " two" }),
    );

    expect(grown?.key).toBe(first?.key);
  });

  it("folds a run of agent messages into one answer", () => {
    // Prose arrives in pieces because it is shown as it is written. One paragraph per piece
    // would break a sentence across a dozen blocks at whatever sizes the network delivered.
    const items = fold(
      ev("agent.message", { text: "I changed " }),
      ev("agent.message", { text: "the header colour." }),
    );

    expect(items).toEqual([
      { kind: "message", key: 1, from: "agent", text: "I changed the header colour." },
    ]);
  });

  it("never folds what the user said into what the agent said", () => {
    const items = fold(
      ev("user.message", { text: "make it blue" }),
      ev("agent.message", { text: "Done." }),
    );

    expect(items.map((i) => (i.kind === "message" ? i.from : i.kind))).toEqual(["user", "agent"]);
  });

  it("starts a new answer after a tool call came between", () => {
    const items = fold(
      ev("agent.message", { text: "Reading the file." }),
      ev("tool.call", { toolCallId: "c1", toolName: "read_file", input: {} }),
      ev("agent.message", { text: "It renders a heading." }),
    );

    expect(items.map((i) => i.kind)).toEqual(["message", "step", "message"]);
  });

  it("starts a new passage after something else happened", () => {
    const items = fold(
      ev("agent.thinking", { text: "before" }),
      ev("agent.message", { text: "Added App.tsx." }),
      ev("agent.thinking", { text: "after" }),
    );

    expect(items.map((i) => i.kind)).toEqual(["thinking", "message", "thinking"]);
  });
});

describe("tool steps", () => {
  it("is still running while it has no result", () => {
    const [step] = stepsOf(fold(call("c1", "run_command", { command: "bun run build" })));

    expect(step?.status).toBe("running");
    expect(step?.toolName).toBe("run_command");
  });

  it("resolves the step with the matching id, not the most recent one", () => {
    // Tools run in the order the model asked for them, but a fold that ignores toolCallId
    // attributes a failure to whichever step happened to be last — so the user reads that
    // the wrong command failed.
    const items = fold(
      call("c1", "read_file", { path: "/home/user/app/a.ts" }),
      call("c2", "run_command", { command: "bun run build" }),
      result("c1", "read_file", true, "contents"),
      result("c2", "run_command", false, "exit code 1"),
    );

    const [first, second] = stepsOf(items);
    expect(first).toMatchObject({ toolCallId: "c1", status: "ok" });
    expect(second).toMatchObject({ toolCallId: "c2", status: "failed", output: "exit code 1" });
  });

  it("still shows a tool whose call this client never received", () => {
    // A client that connected between a call and its result holds only the second. Dropping
    // it would hide a failed command from the one person who needs to see it.
    const items = fold(result("c9", "run_command", false, "exit code 1"));

    expect(stepsOf(items)).toMatchObject([
      { toolCallId: "c9", toolName: "run_command", status: "failed", input: {} },
    ]);
  });

  it("marks a failed result as failed", () => {
    const items = fold(
      call("c1", "run_command", { command: "bun run build" }),
      result("c1", "run_command", false, "exit code 1"),
    );

    expect(stepsOf(items)[0]?.status).toBe("failed");
  });
});

describe("streamed command output", () => {
  it("appends chunks rather than replacing them", () => {
    const items = fold(
      call("c1", "run_command", { command: "bun run build" }),
      ev("command.output", { toolCallId: "c1", stream: "stdout", chunk: "vite v8" }),
      ev("command.output", { toolCallId: "c1", stream: "stdout", chunk: ".0.0 building" }),
      ev("command.output", { toolCallId: "c1", stream: "stdout", chunk: "…\ndone\n" }),
    );

    expect(stepsOf(items)[0]?.streamed).toBe("vite v8.0.0 building…\ndone\n");
  });

  it("keeps earlier chunks when the fold is repeated over a longer list", () => {
    // The hook hands the whole event list back on every frame, so the fold runs from scratch
    // constantly. Output that grew by replacement would flicker down to the newest chunk.
    const base = [
      call("c1", "run_command", { command: "bun run build" }),
      ev("command.output", { toolCallId: "c1", stream: "stdout", chunk: "one\n" }),
    ];
    const more = [
      ...base,
      ev("command.output", { toolCallId: "c1", stream: "stdout", chunk: "two\n" }),
    ];

    expect(stepsOf(buildTranscript(base))[0]?.streamed).toBe("one\n");
    expect(stepsOf(buildTranscript(more))[0]?.streamed).toBe("one\ntwo\n");
  });

  it("routes a chunk to its own step", () => {
    const items = fold(
      call("c1", "run_command", { command: "a" }),
      call("c2", "run_command", { command: "b" }),
      ev("command.output", { toolCallId: "c2", stream: "stdout", chunk: "from b" }),
    );

    const [first, second] = stepsOf(items);
    expect(first?.streamed).toBe("");
    expect(second?.streamed).toBe("from b");
  });

  it("records that something was written to stderr", () => {
    const items = fold(
      call("c1", "run_command", { command: "bun run build" }),
      ev("command.output", { toolCallId: "c1", stream: "stdout", chunk: "ok\n" }),
      ev("command.output", { toolCallId: "c1", stream: "stderr", chunk: "warning\n" }),
    );

    expect(stepsOf(items)[0]?.hasStderr).toBe(true);
  });
});

describe("file changes", () => {
  it("attaches to the step that produced them", () => {
    // The tools emit file.changed between a call and its result, which is the only reason the
    // payload needs no toolCallId.
    const items = fold(
      call("c1", "write_file", { path: "/home/user/app/src/App.tsx" }),
      ev("file.changed", {
        path: "src/App.tsx",
        changeType: "modified",
        diff: "@@ -1 +1 @@\n-a\n+b\n",
      }),
      result("c1", "write_file", true, "Wrote src/App.tsx"),
    );

    expect(stepsOf(items)).toHaveLength(1);
    expect(stepsOf(items)[0]?.files).toMatchObject([
      { path: "src/App.tsx", changeType: "modified" },
    ]);
  });

  it("counts the lines a diff adds and removes", () => {
    const items = fold(
      call("c1", "write_file", { path: "/home/user/app/src/App.tsx" }),
      ev("file.changed", {
        path: "src/App.tsx",
        changeType: "modified",
        diff: "@@ -1,2 +1,3 @@\n-old\n+new\n+extra\n context\n",
      }),
    );

    expect(stepsOf(items)[0]?.files[0]).toMatchObject({ added: 2, removed: 1 });
  });

  it("stands on its own when no step is open", () => {
    // Dropping it would lose the only record that a file changed.
    const items = fold(
      ev("file.changed", { path: "src/App.tsx", changeType: "created", diff: "+a\n" }),
    );

    expect(items.map((i) => i.kind)).toEqual(["files"]);
  });

  it("does not attach to a step that has already finished", () => {
    const items = fold(
      call("c1", "read_file", { path: "/home/user/app/a.ts" }),
      result("c1", "read_file", true, "contents"),
      ev("file.changed", { path: "src/App.tsx", changeType: "created", diff: "+a\n" }),
    );

    expect(stepsOf(items)[0]?.files).toEqual([]);
    expect(items.map((i) => i.kind)).toEqual(["step", "files"]);
  });
});

describe("the rest of the turn", () => {
  it("carries a preview through with its url", () => {
    const items = fold(ev("preview.ready", { url: "https://5173-abc.e2b.dev", port: 5173 }));

    expect(items[0]).toMatchObject({ kind: "preview", url: "https://5173-abc.e2b.dev" });
  });

  it("records the preview stopping, so the log explains why it went away", () => {
    // The pane's own empty state says what to do about it; the transcript's job is the
    // chronology — somebody closing the project in another tab, or the idle sweep, is
    // otherwise an app that vanished for no stated reason.
    const items = fold(ev("preview.stopped", {}));

    expect(items[0]).toEqual({ kind: "preview-stopped", key: 1 });
  });

  it("keeps a system notice out of the agent's voice", () => {
    // The platform explaining itself must not read as something the model said, or the
    // transcript credits the agent with a sentence it never produced.
    const items = fold(
      ev("system.notice", { level: "warning", text: "Could not restore your last snapshot." }),
    );

    expect(items[0]).toEqual({
      kind: "notice",
      key: 1,
      level: "warning",
      text: "Could not restore your last snapshot.",
    });
  });

  it("opens and closes the turn", () => {
    const items = fold(
      ev("turn.started", {}),
      ev("agent.message", { text: "done" }),
      ev("turn.completed", {
        usage: { inputTokens: 1200, outputTokens: 340 },
        durationMs: 8400,
        commitSha: "a1b2c3d",
      }),
    );

    expect(items.map((i) => i.kind)).toEqual(["turn-start", "message", "turn-end"]);
    expect(items[2]).toMatchObject({
      outcome: "completed",
      commitSha: "a1b2c3d",
      durationMs: 8400,
    });
  });

  it("says a turn changed nothing rather than inventing a commit", () => {
    const items = fold(
      ev("turn.completed", {
        usage: { inputTokens: 10, outputTokens: 5 },
        durationMs: 100,
        commitSha: null,
      }),
    );

    expect(items[0]).toMatchObject({ kind: "turn-end", commitSha: null });
  });

  it("closes the turn on failure, carrying the reason", () => {
    const items = fold(
      ev("turn.started", {}),
      ev("turn.failed", { reason: "budget_exceeded", message: "step budget of 40 exceeded" }),
    );

    expect(items[1]).toMatchObject({
      kind: "turn-end",
      outcome: "failed",
      reason: "budget_exceeded",
      message: "step budget of 40 exceeded",
    });
  });
});

describe("stability", () => {
  it("gives every item a key that survives more events arriving", () => {
    // React reuses DOM by key; a key derived from the index would re-key the whole transcript
    // every time an event lands, which is how a collapsed tool step springs open by itself.
    const base = [call("c1", "run_command", { command: "a" })];
    const more = [...base, ev("agent.message", { text: "later" })];

    expect(buildTranscript(base)[0]?.key).toBe(buildTranscript(more)[0]?.key);
  });

  it("is empty for no events", () => {
    expect(buildTranscript([])).toEqual([]);
  });
});

describe("what a failed turn would send again", () => {
  it("carries the message that started that turn", () => {
    const items = buildTranscript([
      ev("user.message", { text: "build a todo list" }),
      ev("turn.started", {}),
      ev("turn.failed", { reason: "sandbox_unavailable", message: "no sandbox" }),
    ]);

    expect(items.at(-1)).toMatchObject({ outcome: "failed", retryMessage: "build a todo list" });
  });

  it("carries each turn's own message, not the latest in the log", () => {
    // The case that makes this worth folding rather than looking up in the component: with two
    // failed turns on screen, "the last user message" is the same string for both, and one of
    // the two retry buttons would silently re-send the wrong request.
    const items = buildTranscript([
      ev("user.message", { text: "first ask" }),
      ev("turn.started", {}),
      ev("turn.failed", { reason: "internal", message: "boom" }),
      ev("user.message", { text: "second ask" }),
      ev("turn.started", {}),
      ev("turn.failed", { reason: "internal", message: "boom again" }),
    ]);

    const failures = items.filter((item) => item.kind === "turn-end");
    expect(
      failures.map((item) => ("retryMessage" in item ? item.retryMessage : undefined)),
    ).toEqual(["first ask", "second ask"]);
  });

  it("is undefined for a log that begins mid-turn", () => {
    // What a client joining with `afterSeq` sees. Offering a retry with nothing to send would
    // be a button that quietly does nothing.
    const items = buildTranscript([ev("turn.failed", { reason: "internal", message: "boom" })]);

    expect(items.at(-1)).toMatchObject({ retryMessage: undefined });
  });
});
