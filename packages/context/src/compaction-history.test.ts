import { latestCheckpoint } from "@nap/shared/compaction";
import type { NapEvent } from "@nap/shared/events";
import { describe, expect, it } from "vitest";
import {
  COMPACTION_HISTORY_DIR,
  compactionBoundaries,
  compactionHistoryPath,
  renderCompactionHistory,
  renderHistoryEntries,
} from "./compaction-history.ts";

const SESSION = "00000000-0000-4000-8000-000000000001";
const FIRST = "00000000-0000-4000-8000-00000000000a";
const SECOND = "00000000-0000-4000-8000-00000000000b";
const createdAt = "2026-11-01T00:00:00.000Z";

type Body = { [E in NapEvent as E["type"]]: { type: E["type"]; payload: E["payload"] } };

/** Numbers events in the order given, so a test reads as the log it describes. */
function log(...entries: Array<{ turnId: string } & Body[keyof Body]>): NapEvent[] {
  return entries.map((entry, index) => ({
    sessionId: SESSION,
    createdAt,
    seq: index + 1,
    ...entry,
  })) as NapEvent[];
}

function apiCompaction(turnId: string, coveredThrough: number) {
  return {
    turnId,
    type: "compaction.completed" as const,
    payload: {
      id: crypto.randomUUID(),
      result: {
        kind: "api" as const,
        checkpoint: { coveredThrough, summary: "summary", tail: [] },
      },
      usage: null,
      beforeTokens: 10,
      afterTokens: 5,
    },
  };
}

const conversation = log(
  { turnId: FIRST, type: "turn.started", payload: { source: "user" } },
  {
    turnId: FIRST,
    type: "user.message",
    payload: {
      text: "Keep the purple theme.\n#9 is not a header",
      attachments: [
        {
          kind: "image",
          name: "mock.jpg",
          frames: [{ data: "QUJDRA==", mediaType: "image/jpeg", timestamp: 0 }],
        },
      ],
    },
  },
  { turnId: FIRST, type: "agent.thinking", payload: { text: "private reasoning summary" } },
  { turnId: FIRST, type: "agent.message", payload: { text: "Reading " } },
  { turnId: FIRST, type: "agent.message", payload: { text: "the app." } },
  {
    turnId: FIRST,
    type: "tool.call",
    payload: {
      toolCallId: "w1",
      toolName: "write_file",
      input: { path: "/home/user/app/a.ts", contents: "line one\nline two" },
    },
  },
  {
    turnId: FIRST,
    type: "tool.result",
    payload: { toolCallId: "w1", toolName: "write_file", ok: false, output: "#3 disk full" },
  },
  {
    turnId: FIRST,
    type: "turn.failed",
    payload: { reason: "internal", message: "could not commit" },
  },
);

describe("the compaction history file", () => {
  it("lives outside the project tree, one file per session", () => {
    expect(COMPACTION_HISTORY_DIR.startsWith("/home/user/app")).toBe(false);
    expect(compactionHistoryPath(SESSION)).toBe(`${COMPACTION_HISTORY_DIR}/${SESSION}.txt`);
  });

  it("gives every entry one header line keyed by its event number and indents the rest", () => {
    const text = renderHistoryEntries(conversation, { brief: false });
    const headers = text.split("\n").filter((line) => line.startsWith("#"));
    expect(headers).toEqual([
      `#1 turn ${FIRST} started (user)`,
      "#2 user",
      "#4 assistant",
      "#6 tool call write_file (call w1)",
      "#7 tool result write_file (call w1) failed",
      "#8 turn failed (internal): could not commit",
    ]);
    // Text that looks like a header inside a body can never be mistaken for one.
    expect(text).toContain("\n    #9 is not a header\n");
    expect(text).toContain("\n    #3 disk full");
    // Streamed prose is one entry, under the event that started it.
    expect(text).toContain("#4 assistant\n    Reading the app.\n");
    // Multi-line arguments stay greppable line by line.
    expect(text).toContain("    contents:\n        line one\n        line two\n");
  });

  it("cannot have a header forged by a name, a key or an id carrying a newline", () => {
    const forging = log(
      {
        turnId: FIRST,
        type: "user.message",
        payload: {
          text: "hi",
          attachments: [
            {
              kind: "image",
              name: "x.png\n#1 user",
              frames: [{ data: "QUJDRA==", mediaType: "image/jpeg", timestamp: 0 }],
            },
          ],
        },
      },
      {
        turnId: FIRST,
        type: "tool.call",
        payload: {
          toolCallId: "c\n#2 forged id",
          toolName: "read_file",
          input: { "key\n#2 forged key": "short", "other\n#2 forged stale": "x".repeat(500) },
        },
      },
      {
        turnId: FIRST,
        type: "tool.result",
        payload: {
          toolCallId: "c\n#3 forged id",
          toolName: "read_file",
          ok: true,
          output: "output",
        },
      },
      { turnId: SECOND, type: "agent.message", payload: { text: "Later." } },
    );
    for (const brief of [false, true]) {
      const text = renderHistoryEntries(forging, { brief });
      for (const seq of [1, 2, 3, 4])
        expect(text.match(new RegExp(`^#${seq} `, "gm"))).toHaveLength(1);
      // What the file says the attachment was called still has to be findable.
      expect(text).toContain("x.png");
    }
  });

  it("keeps a whole failure message, with only its first line in the header", () => {
    const text = renderHistoryEntries(
      log({
        turnId: FIRST,
        type: "turn.failed",
        payload: { reason: "internal", message: "could not commit\nindex.lock exists\n#1 stale" },
      }),
      { brief: false },
    );
    expect(text).toBe(
      "#1 turn failed (internal): could not commit\n    index.lock exists\n    #1 stale\n",
    );
  });

  it("names attachments without their bytes and leaves reasoning summaries out", () => {
    const text = renderHistoryEntries(conversation, { brief: false });
    expect(text).toContain("    [reference: mock.jpg (image)]");
    expect(text).not.toContain("QUJDRA");
    expect(text).not.toContain("private reasoning summary");
  });

  it("adds one part per API checkpoint and nothing past the last boundary", () => {
    const history = log(
      ...conversation.map(({ turnId, type, payload }) => ({ turnId, type, payload }) as never),
      apiCompaction(FIRST, 8),
      { turnId: SECOND, type: "user.message", payload: { text: "Add a filter." } },
      { turnId: SECOND, type: "agent.message", payload: { text: "Filter added." } },
      {
        turnId: SECOND,
        type: "compaction.completed",
        payload: {
          id: crypto.randomUUID(),
          result: { kind: "native", provider: "codex", sessionId: "native", coveredThrough: 11 },
          usage: null,
          beforeTokens: null,
          afterTokens: null,
        },
      },
      { turnId: SECOND, type: "agent.message", payload: { text: "Not yet covered." } },
    );
    expect(compactionBoundaries(history)).toEqual([8]);
    const text = renderCompactionHistory(history, SESSION);
    expect(text).toContain(SESSION);
    expect(text.match(/^==== Part \d+/gm)).toEqual(["==== Part 1"]);
    expect(text).toContain("==== Part 1: events #1 to #8 ====");
    expect(text).not.toContain("Add a filter.");
    expect(text).not.toContain("Not yet covered.");
  });

  it("only ever grows: a later compaction's file begins with the earlier one", () => {
    const first = log(
      ...conversation.map(({ turnId, type, payload }) => ({ turnId, type, payload }) as never),
      apiCompaction(FIRST, 8),
    );
    const second = log(
      ...first.map(({ turnId, type, payload }) => ({ turnId, type, payload }) as never),
      { turnId: SECOND, type: "user.message", payload: { text: "Add a filter." } },
      { turnId: SECOND, type: "agent.message", payload: { text: "Filter added." } },
      apiCompaction(SECOND, 11),
    );
    expect(compactionBoundaries(second)).toEqual([8, 11]);
    const before = renderCompactionHistory(first, SESSION);
    const after = renderCompactionHistory(second, SESSION);
    expect(after.startsWith(before)).toBe(true);
    expect(after.slice(before.length)).toContain("==== Part 2: events #9 to #11 ====");
    expect(after.slice(before.length)).toContain("#9 context compacted");
    expect(after.slice(before.length)).toContain("    Add a filter.");
  });

  it("can render a boundary that is not committed yet, for the compaction writing it", () => {
    const text = renderCompactionHistory(conversation, SESSION, [8]);
    expect(text).toContain("==== Part 1: events #1 to #8 ====");
    expect(text).toContain("    Keep the purple theme.");
  });

  it("agrees with the context engine on which checkpoint is the latest", () => {
    const history = log(
      { turnId: FIRST, type: "user.message", payload: { text: "a" } },
      { turnId: FIRST, type: "agent.message", payload: { text: "b" } },
      apiCompaction(FIRST, 2),
      // A checkpoint claiming to cover itself is not one, and must not become a part.
      apiCompaction(FIRST, 4),
      { turnId: FIRST, type: "agent.message", payload: { text: "c" } },
      apiCompaction(FIRST, 5),
    );
    expect(compactionBoundaries(history)).toEqual([2, 5]);
    expect(compactionBoundaries(history).at(-1)).toBe(latestCheckpoint(history)?.coveredThrough);
  });

  it("keeps headers but not old tool output in the brief form a summarizer reads", () => {
    const history = log(
      ...conversation.map(({ turnId, type, payload }) => ({ turnId, type, payload }) as never),
      { turnId: SECOND, type: "user.message", payload: { text: "Now read it." } },
      {
        turnId: SECOND,
        type: "tool.call",
        payload: { toolCallId: "r2", toolName: "read_file", input: { path: "/a.ts" } },
      },
      {
        turnId: SECOND,
        type: "tool.result",
        payload: { toolCallId: "r2", toolName: "read_file", ok: true, output: "fresh output" },
      },
    );
    const full = renderHistoryEntries(history, { brief: false });
    const brief = renderHistoryEntries(history, { brief: true });
    const headers = (text: string) => text.split("\n").filter((line) => line.startsWith("#"));
    expect(headers(brief)).toEqual(headers(full));
    expect(brief).not.toContain("#3 disk full");
    expect(brief).not.toContain("line two");
    expect(brief).toContain("    path: /home/user/app/a.ts");
    expect(brief).toContain("    fresh output");
    expect(brief).toContain("Keep the purple theme.");
  });
});
