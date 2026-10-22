import type { NapEvent, NapEventType } from "@nap/shared/events";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { describe, expect, it } from "vitest";
import { buildTimeline, LIVE_ACTIVITY_ROW_ID, type TimelineRow } from "./timeline.ts";
import { buildTranscript } from "./transcript.ts";

/**
 * The third fold: transcript items into the rows the timeline draws.
 *
 * `buildTranscript` says what happened; this says how much of it a reader sees — a finished turn
 * shrinks to its prompt, one "Worked for" row and its answer; a run of tool calls is one sentence;
 * the call still going is one live row. Every interesting case is about which items end up behind
 * which row, so the assertions read the rows' kinds and what each one covers.
 */

const SESSION = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";
const TURN = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
const NEXT_TURN = "8d2e3f4a-5b6c-4d7e-9f80-1a2b3c4d5e61";
const COMPACT_TURN = "9e3f4a5b-6c7d-4e8f-8a91-2b3c4d5e6f72";

let nextSeq = 1;
let clock = 0;

function ev<T extends NapEventType>(
  type: T,
  payload: Extract<NapEvent, { type: T }>["payload"],
  turnId = TURN,
) {
  return {
    type,
    sessionId: SESSION,
    turnId,
    seq: nextSeq++,
    createdAt: new Date(Date.UTC(2026, 7, 9, 12, 0, 0) + clock).toISOString(),
    payload,
  } as StoredEvent;
}

/** Moves the clock the events are stamped with, so a turn's duration is something to assert. */
function after(ms: number) {
  clock += ms;
}

function reset() {
  nextSeq = 1;
  clock = 0;
}

const prompt = (text = "build me a todo list", turnId = TURN) =>
  ev("user.message", { text }, turnId);
const started = (turnId = TURN) => ev("turn.started", { source: "user" }, turnId);
const say = (text: string, turnId = TURN) => ev("agent.message", { text }, turnId);
const think = (text: string) => ev("agent.thinking", { text });
let nextCall = 1;
function call(toolName: "read_file" | "run_command" | "edit_file", input: Record<string, unknown>) {
  const id = `c${nextCall++}`;
  return { id, event: ev("tool.call", { toolCallId: id, toolName, input }) };
}
const result = (
  id: string,
  toolName: "read_file" | "run_command" | "edit_file",
  ok = true,
  output = "",
) => ev("tool.result", { toolCallId: id, toolName, ok, output });
function read(path: string) {
  const { id, event } = call("read_file", { path });
  return [event, result(id, "read_file", true, "file contents")];
}
function run(command: string, output = "exit code 0\n") {
  const { id, event } = call("run_command", { command });
  return [event, result(id, "run_command", true, output)];
}
function edit(path: string, diff = "+one\n") {
  const { id, event } = call("edit_file", { path });
  return [
    event,
    ev("file.changed", { path, changeType: "modified", diff }),
    result(id, "edit_file", true, "ok"),
  ];
}
const completed = (durationMs: number, turnId = TURN) =>
  ev(
    "turn.completed",
    { usage: { inputTokens: 1, outputTokens: 1 }, durationMs, commitSha: "a1b2c3d" },
    turnId,
  );
const failed = (reason: "cancelled" | "internal", message = "stopped", turnId = TURN) =>
  ev("turn.failed", { reason, message }, turnId);

/**
 * A manual `/compact`, as the runtime writes it: a turn of its own with no `user.message`, so
 * nothing in the log but its own events says where it begins.
 */
function compaction(outcome: "completed" | "failed" | "cancelled") {
  const opening = [
    ev("compaction.started", { id: "k1", trigger: "manual" }, COMPACT_TURN),
    started(COMPACT_TURN),
  ];
  after(4_000);
  if (outcome === "completed") {
    return [
      ...opening,
      ev(
        "compaction.completed",
        {
          id: "k1",
          result: { kind: "native", provider: "codex", sessionId: "native1", coveredThrough: 0 },
          usage: null,
          beforeTokens: null,
          afterTokens: null,
        },
        COMPACT_TURN,
      ),
      completed(4_000, COMPACT_TURN),
    ];
  }
  const cancelled = outcome === "cancelled";
  const message = cancelled ? "stopped" : "provider unavailable";
  return [
    ...opening,
    ev("compaction.failed", { id: "k1", message, cancelled, usage: null }, COMPACT_TURN),
    failed(cancelled ? "cancelled" : "internal", message, COMPACT_TURN),
  ];
}

type Options = Partial<Parameters<typeof buildTimeline>[1]>;

function rows(events: StoredEvent[], options: Options = {}): TimelineRow[] {
  return buildTimeline(buildTranscript(events), {
    running: false,
    expandedFolds: new Set(),
    expandedGroups: new Set(),
    ...options,
  });
}

const SHAPE: Record<Exclude<TimelineRow["kind"], "item">, string> = {
  "work-entry": "entry",
  "work-toggle": "toggle",
  "work-group": "group",
  "work-live": "live",
  working: "working",
  "turn-fold": "fold",
  "changed-files": "changed-files",
};

/** Each row as a short word, so a whole timeline's shape is one readable assertion. */
function shape(timeline: readonly TimelineRow[]): string[] {
  return timeline.map((row) => {
    if (row.kind !== "item") return SHAPE[row.kind];
    return row.item.kind === "message" ? row.item.from : row.item.kind;
  });
}

function only<K extends TimelineRow["kind"]>(timeline: readonly TimelineRow[], kind: K) {
  const found = timeline.filter(
    (row): row is Extract<TimelineRow, { kind: K }> => row.kind === kind,
  );
  expect(found).toHaveLength(1);
  return found[0] as Extract<TimelineRow, { kind: K }>;
}

describe("folding a finished turn", () => {
  it("hides everything between the prompt and the answer behind one row", () => {
    reset();
    const timeline = rows([
      prompt(),
      started(),
      think("Reading the project first."),
      ...read("src/App.tsx"),
      say("Let me check the build."),
      ...run("bun run build"),
      say("Added a todo list."),
      completed(72_000),
    ]);

    expect(shape(timeline)).toEqual(["user", "fold", "turn-start", "agent", "turn-end"]);
    expect(only(timeline, "turn-fold").label).toBe("Worked for 1m 12s");
  });

  it("shows the work again, in place, once the row is opened", () => {
    reset();
    const events = [
      prompt(),
      started(),
      ...read("src/App.tsx"),
      ...read("src/main.tsx"),
      say("Added a todo list."),
      completed(8_400),
    ];
    const fold = only(rows(events), "turn-fold");

    const opened = rows(events, { expandedFolds: new Set([fold.foldId]) });

    expect(shape(opened)).toEqual(["user", "fold", "turn-start", "toggle", "agent", "turn-end"]);
    expect(only(opened, "turn-fold").expanded).toBe(true);
  });

  it("says you stopped it when the turn was cancelled", () => {
    reset();
    const events = [prompt(), started()];
    after(12_000);
    events.push(...run("bun install"), failed("cancelled"));

    expect(only(rows(events), "turn-fold").label).toBe("You stopped after 12s");
  });

  it("leaves a turn that failed for any other reason open", () => {
    // The work that led to a failure is what somebody reading the failure needs to see.
    reset();
    const timeline = rows([prompt(), started(), ...run("bun run build"), failed("internal")]);

    expect(shape(timeline)).not.toContain("fold");
  });

  it("leaves a turn that has not finished open", () => {
    reset();
    const timeline = rows([prompt(), started(), ...read("src/App.tsx"), say("Working on it")]);

    expect(shape(timeline)).not.toContain("fold");
  });

  it("does not fold a turn that did no work", () => {
    reset();
    const timeline = rows([prompt(), started(), say("Hello!"), completed(900)]);

    expect(shape(timeline)).toEqual(["user", "turn-start", "agent", "turn-end"]);
  });

  it("folds trailing work after the answer but not a trailing failure", () => {
    reset();
    const timeline = rows([
      prompt(),
      started(),
      ...read("src/App.tsx"),
      say("Done."),
      ...run("bun run lint", "exit code 1\nlint error\n"),
      completed(5_000),
    ]);

    expect(shape(timeline)).toEqual(["user", "fold", "turn-start", "agent", "entry", "turn-end"]);
  });

  it("folds each turn on its own", () => {
    reset();
    const timeline = rows([
      prompt("first"),
      started(),
      ...read("a.ts"),
      say("One."),
      completed(1_000),
      prompt("second", NEXT_TURN),
      started(NEXT_TURN),
      ...run("ls"),
      say("Two.", NEXT_TURN),
      completed(2_000, NEXT_TURN),
    ]);

    expect(timeline.filter((row) => row.kind === "turn-fold")).toHaveLength(2);
  });

  it("covers the keys it hides, so the unseen seam can land on it", () => {
    reset();
    const timeline = rows([
      prompt(),
      started(),
      ...read("src/App.tsx"),
      ...read("src/main.tsx"),
      say("Done."),
      completed(1_000),
    ]);
    const fold = only(timeline, "turn-fold");

    // The prompt is 1 and `turn.started` 2; the two reads are keyed by their calls, 3 and 5.
    expect(fold.keys).toEqual({ first: 3, last: 5 });
  });
});

describe("a turn that has no prompt of its own", () => {
  const finishedTurn = () => [
    prompt(),
    started(),
    ...edit("src/App.tsx"),
    say("Added a todo list."),
    completed(72_000),
  ];

  it("leaves the turn before a manual compaction its own duration", () => {
    reset();
    const timeline = rows([...finishedTurn(), ...compaction("completed")]);

    expect(only(timeline, "turn-fold").label).toBe("Worked for 1m 12s");
    expect(only(timeline, "changed-files").files.map((file) => file.path)).toEqual(["src/App.tsx"]);
  });

  it.each(["failed", "cancelled"] as const)(
    "keeps the earlier turn folded, with its changed files, after a %s compaction",
    (outcome) => {
      reset();
      const timeline = rows([...finishedTurn(), ...compaction(outcome)]);

      expect(only(timeline, "turn-fold").label).toBe("Worked for 1m 12s");
      expect(shape(timeline)).toContain("changed-files");
    },
  );
});

describe("other turns that fold on their own", () => {
  it("folds a repair turn apart from the turn it repairs", () => {
    // The verifier's prompt is a prompt, so the repair is a response of its own.
    reset();
    const timeline = rows([
      prompt(),
      started(),
      ...read("a.ts"),
      say("Done."),
      completed(1_000),
      ev("user.message", { text: "The build failed." }, NEXT_TURN),
      ev("turn.started", { source: "verification" }, NEXT_TURN),
      ...run("bun run build"),
      say("Fixed it.", NEXT_TURN),
      completed(2_000, NEXT_TURN),
    ]);

    expect(shape(timeline)).toEqual([
      "user",
      "fold",
      "turn-start",
      "agent",
      "turn-end",
      "verifier",
      "fold",
      "turn-start",
      "agent",
      "turn-end",
    ]);
    expect(timeline.flatMap((row) => (row.kind === "turn-fold" ? [row.label] : []))).toEqual([
      "Worked for 1.0s",
      "Worked for 2.0s",
    ]);
  });

  it("does not fold a turn stopped before it started, which did no work", () => {
    reset();
    const timeline = rows([prompt(), failed("cancelled")]);

    expect(shape(timeline)).not.toContain("fold");
  });

  it("cannot say how long a stopped turn ran when its start is not in the log", () => {
    // A client that joined mid-turn has the work and the cancel, and nothing to measure from.
    reset();
    const timeline = rows([prompt(), ...run("bun install"), failed("cancelled")]);

    expect(only(timeline, "turn-fold").label).toBe("You stopped this response");
  });
});

describe("the changed files of a turn", () => {
  it("lists them under the answer once the turn has completed, one per path", () => {
    reset();
    const timeline = rows([
      prompt(),
      started(),
      ...edit("src/App.tsx", "+a\n+b\n"),
      ...edit("src/App.tsx", "-a\n"),
      ...edit("src/main.tsx"),
      say("Done."),
      completed(1_000),
    ]);

    expect(shape(timeline)).toEqual([
      "user",
      "fold",
      "turn-start",
      "agent",
      "changed-files",
      "turn-end",
    ]);
    const card = only(timeline, "changed-files");
    expect(card.files.map((file) => [file.path, file.added, file.removed])).toEqual([
      ["src/App.tsx", 2, 1],
      ["src/main.tsx", 1, 0],
    ]);
  });

  it("keeps the card on a folded turn that ended without an answer", () => {
    reset();
    const timeline = rows([prompt(), started(), ...edit("src/App.tsx"), completed(1_000)]);

    expect(shape(timeline)).toEqual(["user", "fold", "turn-start", "changed-files", "turn-end"]);
  });

  it("says nothing of a failed turn's files, which were never committed", () => {
    reset();
    const timeline = rows([prompt(), started(), ...edit("src/App.tsx"), failed("cancelled")]);

    expect(shape(timeline)).not.toContain("changed-files");
  });
});

describe("grouping the work", () => {
  it("makes one row of adjacent tool calls, named in a sentence", () => {
    reset();
    const timeline = rows([prompt(), ...read("a.ts"), ...read("b.ts"), ...run("bun test")]);

    expect(shape(timeline)).toEqual(["user", "toggle"]);
    expect(only(timeline, "work-toggle").summary).toBe("Read 2 files and ran 1 command");
  });

  it("lets prose divide the work into what came before and after it", () => {
    reset();
    const timeline = rows([
      prompt(),
      ...read("a.ts"),
      ...read("b.ts"),
      say("Now the build."),
      ...run("ls"),
    ]);

    expect(shape(timeline)).toEqual(["user", "toggle", "agent", "entry"]);
  });

  it("puts reasoning in the group rather than in the conversation", () => {
    reset();
    const timeline = rows([prompt(), think("I should read it."), ...read("a.ts")]);

    expect(shape(timeline)).toEqual(["user", "toggle"]);
    expect(only(timeline, "work-toggle").entries.map((entry) => entry.kind)).toEqual([
      "thinking",
      "step",
    ]);
  });

  it("names a lone change by what it changed", () => {
    reset();
    const timeline = rows([prompt(), ...edit("src/App.tsx")]);

    expect(only(timeline, "work-entry").displayLabel).toBe("Changed 1 file");
  });

  it("lists the group beneath its row once it is opened", () => {
    reset();
    const events = [prompt(), ...read("a.ts"), ...read("b.ts")];
    const toggle = only(rows(events), "work-toggle");

    const opened = rows(events, { expandedGroups: new Set([toggle.groupId]) });

    expect(shape(opened)).toEqual(["user", "toggle", "group"]);
    expect(only(opened, "work-group").entries).toHaveLength(2);
  });

  it("keeps the id it opened with as the group grows", () => {
    // The id is what the group's open state is kept under. Keyed to the newest member instead,
    // a group somebody had opened would spring shut on the next tool result.
    reset();
    const first = [prompt(), ...read("a.ts"), ...read("b.ts")];
    const before = only(rows(first), "work-toggle").groupId;
    const grown = only(rows([...first, ...read("c.ts")]), "work-toggle").groupId;

    expect(grown).toBe(before);
  });
});

describe("a turn that is running", () => {
  it("says it is working right under the prompt, and what it is doing at the end", () => {
    reset();
    const { event } = call("run_command", { command: "bun run build" });
    const timeline = rows([prompt(), started(), ...read("a.ts"), say("Building."), event], {
      running: true,
      startedAt: "2026-08-09T12:00:00.000Z",
    });

    expect(shape(timeline)).toEqual(["user", "working", "turn-start", "entry", "agent", "live"]);
    const live = only(timeline, "work-live");
    expect(live.entry?.kind === "step" && live.entry.toolName).toBe("run_command");
    expect(only(timeline, "working").startedAt).toBe("2026-08-09T12:00:00.000Z");
  });

  it("shows the newest call alone, with the rest of its group behind it", () => {
    reset();
    const { event } = call("run_command", { command: "bun test" });
    const timeline = rows([prompt(), started(), ...read("a.ts"), ...read("b.ts"), event], {
      running: true,
    });

    expect(shape(timeline)).toEqual(["user", "working", "turn-start", "live"]);
    expect(only(timeline, "work-live").entries).toHaveLength(3);
  });

  it("is thinking when nothing has been called yet", () => {
    reset();
    const timeline = rows([prompt(), started()], { running: true });
    const live = only(timeline, "work-live");

    expect(live.entry).toBeUndefined();
    expect(live.groupId).toBeUndefined();
  });

  it("keeps one row id from thinking to running, so the row morphs instead of remounting", () => {
    reset();
    const thinking = only(rows([prompt(), started()], { running: true }), "work-live");
    const { event } = call("run_command", { command: "bun test" });
    const running = only(rows([prompt(), started(), event], { running: true }), "work-live");

    expect(thinking.id).toBe(LIVE_ACTIVITY_ROW_ID);
    expect(running.id).toBe(LIVE_ACTIVITY_ROW_ID);
  });

  it("previews the latest thought above the live row", () => {
    reset();
    const timeline = rows(
      [prompt(), started(), think("**Reading**\n\nfirst\n\n**Planning the header**\n\nIt needs")],
      { running: true },
    );

    expect(only(timeline, "work-live").thought).toBe("Planning the header");
  });

  it("goes back to thinking after a failed call", () => {
    // The model reads the failure and decides what to do next; until it calls something else,
    // what it is doing is thinking. The failure is behind the row, one click away.
    reset();
    const timeline = rows([prompt(), started(), ...run("bun run build", "exit code 2\nerror\n")], {
      running: true,
    });
    const live = only(timeline, "work-live");

    expect(live.entry).toBeUndefined();
    expect(live.groupId).toBeDefined();
  });

  it("opens the live group beneath the row", () => {
    reset();
    const events = [prompt(), started(), ...read("a.ts"), call("read_file", { path: "b" }).event];
    const live = only(rows(events, { running: true }), "work-live");

    const opened = rows(events, {
      running: true,
      expandedGroups: new Set([live.groupId ?? ""]),
    });

    expect(shape(opened)).toEqual(["user", "working", "turn-start", "live", "group"]);
  });

  it("leaves the live row out while context is being compacted", () => {
    reset();
    const timeline = rows(
      [prompt(), started(), ev("compaction.started", { id: "k1", trigger: "automatic" })],
      { running: true },
    );

    expect(shape(timeline)).not.toContain("live");
    expect(shape(timeline)).toContain("working");
  });

  it("puts the working row at the open turn's start when that turn has no prompt in this log", () => {
    // A client that joined mid-turn, or a compaction turn, which has no message of its own:
    // under the last prompt would be under somebody else's turn.
    reset();
    const timeline = rows([...read("a.ts")], { running: true });

    expect(shape(timeline)).toEqual(["working", "live"]);
  });

  it("does not fold the turn that is still running", () => {
    reset();
    const timeline = rows(
      [
        prompt("first"),
        started(),
        ...read("a.ts"),
        say("One."),
        completed(1_000),
        prompt("second", NEXT_TURN),
        started(NEXT_TURN),
      ],
      { running: true },
    );

    expect(shape(timeline)).toEqual([
      "user",
      "fold",
      "turn-start",
      "agent",
      "turn-end",
      "user",
      "working",
      "turn-start",
      "live",
    ]);
  });

  it("says it is working, but not thinking, before the turn has started", () => {
    // Between the prompt and `turn.started` the runtime is acquiring a sandbox. No model has been
    // asked anything yet, so "Thinking" would be a guess.
    reset();
    const timeline = rows([prompt()], { running: true });

    expect(shape(timeline)).toEqual(["user", "working"]);
  });

  it("draws nothing running under a turn that has ended while its checks still hold the lease", () => {
    reset();
    const timeline = rows([prompt(), started(), ...read("a.ts"), say("Done."), completed(1_000)], {
      running: true,
    });

    expect(shape(timeline)).toEqual(["user", "fold", "turn-start", "agent", "turn-end"]);
  });

  it("still says it is working when a request is waiting to be logged after a turn ended", () => {
    // A request queued behind a compaction: sent, and not in the log until the compaction ends.
    reset();
    const timeline = rows([prompt(), started(), say("Done."), completed(1_000)], {
      running: true,
      pending: true,
    });

    expect(shape(timeline)).toEqual(["user", "turn-start", "agent", "turn-end", "working"]);
  });

  it("keeps the live group's id once the turn has finished, so an opened group stays open", () => {
    reset();
    const running = [prompt(), started(), ...read("a.ts"), call("read_file", { path: "b" }).event];
    const live = only(rows(running, { running: true }), "work-live");
    const finished = [...running, say("Done."), completed(1_000)];
    const opened = rows(finished, {
      expandedFolds: new Set([only(rows(finished), "turn-fold").foldId]),
    });

    expect(only(opened, "work-toggle").groupId).toBe(live.groupId);
  });
});
