import { type NapEvent, NapEventSchema, type NapEventType } from "@nap/shared/events";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { describe, expect, it } from "vitest";
import { eventLogLine } from "./turn-log.ts";

const SESSION = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";
const TURN = "9c1d2e3f-4a5b-6c7d-8e9f-0a1b2c3d4e5f";

function stored<T extends NapEvent>(event: T): StoredEvent {
  return event;
}

function base(seq: number) {
  return { sessionId: SESSION, turnId: TURN, seq, createdAt: "2026-08-10T00:00:00.000Z" } as const;
}

/** One of every event type, so the exhaustiveness assertions below have something to walk. */
const ONE_OF_EACH: Record<NapEventType, StoredEvent> = {
  "user.message": stored({
    ...base(1),
    type: "user.message",
    payload: { text: "build a todo app" },
  }),
  "agent.thinking": stored({
    ...base(2),
    type: "agent.thinking",
    payload: { text: "considering" },
  }),
  "agent.message": stored({ ...base(3), type: "agent.message", payload: { text: "on it" } }),
  "tool.call": stored({
    ...base(4),
    type: "tool.call",
    payload: { toolCallId: "c1", toolName: "write_file", input: { path: "src/App.tsx" } },
  }),
  "tool.result": stored({
    ...base(5),
    type: "tool.result",
    payload: { toolCallId: "c1", toolName: "write_file", ok: false, output: "no such directory" },
  }),
  "file.changed": stored({
    ...base(6),
    type: "file.changed",
    payload: { path: "src/App.tsx", changeType: "modified", diff: "@@ -1 +1 @@\n-a\n+b" },
  }),
  "command.output": stored({
    ...base(7),
    type: "command.output",
    payload: { toolCallId: "c2", stream: "stderr", chunk: "error: secret token leaked" },
  }),
  "preview.ready": stored({
    ...base(8),
    type: "preview.ready",
    payload: { url: "https://5173-abc.e2b.app", port: 5173 },
  }),
  "turn.started": stored({ ...base(9), type: "turn.started", payload: {} }),
  "turn.completed": stored({
    ...base(10),
    type: "turn.completed",
    payload: {
      usage: { inputTokens: 12480, outputTokens: 1340 },
      durationMs: 18400,
      commitSha: "a1b2c3d",
    },
  }),
  "turn.failed": stored({
    ...base(11),
    type: "turn.failed",
    payload: { reason: "budget_exceeded", message: "ran out of steps" },
  }),
  "system.notice": stored({
    ...base(12),
    type: "system.notice",
    payload: { level: "warning", text: "restored from a snapshot" },
  }),
};

describe("eventLogLine", () => {
  it("covers every event type", () => {
    // The table above is the fixture *and* the exhaustiveness check: a new member of the union
    // fails to compile here until it has a case, rather than logging as an unlabelled seq.
    expect(Object.keys(ONE_OF_EACH)).toHaveLength(NapEventSchema.options.length);
  });

  it("names the type and the sequence number on every line", () => {
    // `seq` is what puts a turn's lines back in order — log timestamps are per-line and two
    // events appended in the same millisecond sort arbitrarily by them.
    for (const event of Object.values(ONE_OF_EACH)) {
      expect(eventLogLine(event).fields).toMatchObject({ eventType: event.type, seq: event.seq });
    }
  });

  it("says which tool ran and whether it worked", () => {
    // The minimum for following a turn: which tools, in what order, and which one broke.
    expect(eventLogLine(ONE_OF_EACH["tool.call"]).fields).toMatchObject({
      toolName: "write_file",
      toolCallId: "c1",
    });
    expect(eventLogLine(ONE_OF_EACH["tool.result"]).fields).toMatchObject({
      toolName: "write_file",
      toolCallId: "c1",
      ok: false,
    });
  });

  it("says which file changed and how", () => {
    expect(eventLogLine(ONE_OF_EACH["file.changed"]).fields).toMatchObject({
      path: "src/App.tsx",
      changeType: "modified",
    });
  });

  it("carries the turn's cost and duration", () => {
    expect(eventLogLine(ONE_OF_EACH["turn.completed"]).fields).toMatchObject({
      durationMs: 18400,
      inputTokens: 12480,
      outputTokens: 1340,
      commitSha: "a1b2c3d",
    });
  });

  it("carries why a turn failed", () => {
    expect(eventLogLine(ONE_OF_EACH["turn.failed"]).fields).toMatchObject({
      reason: "budget_exceeded",
    });
  });

  it("logs command output at debug, so a noisy build cannot bury the turn it belongs to", () => {
    expect(eventLogLine(ONE_OF_EACH["command.output"]).level).toBe("debug");
  });

  it("logs trouble above info, which is how anyone finds it without knowing to look", () => {
    // A failure rate is measured off these two. At info they are indistinguishable from the
    // turn that went perfectly.
    expect(eventLogLine(ONE_OF_EACH["turn.failed"]).level).toBe("warn");
    expect(eventLogLine(ONE_OF_EACH["system.notice"]).level).toBe("warn");
  });

  it("logs an informational notice at info rather than crying wolf", () => {
    const notice = ONE_OF_EACH["system.notice"];
    expect(
      eventLogLine({ ...notice, payload: { level: "info", text: "hello" } } as StoredEvent).level,
    ).toBe("info");
  });

  it("logs the ordinary course of a turn at info", () => {
    for (const [type, event] of Object.entries(ONE_OF_EACH)) {
      if (type === "command.output" || type === "turn.failed" || type === "system.notice") continue;
      expect(eventLogLine(event).level).toBe("info");
    }
  });

  it("never puts what the user or the model wrote into a log line", () => {
    // Logs go somewhere different from the events table, are kept on a different schedule and
    // are read by people who are not the author. The transcript, the diffs and the command
    // output are all in `events` already, addressable by the very ids these lines carry —
    // copying them here would be a second, less careful home for a user's private project.
    const secrets = [
      "build a todo app",
      "considering",
      "on it",
      "no such directory",
      "@@ -1 +1 @@",
      "error: secret token leaked",
      "restored from a snapshot",
      "ran out of steps",
    ];

    for (const event of Object.values(ONE_OF_EACH)) {
      const rendered = JSON.stringify(eventLogLine(event).fields);
      for (const secret of secrets) expect(rendered).not.toContain(secret);
    }
  });

  it("reports the size of what it will not quote", () => {
    // Enough to tell "the model said nothing" from "the model wrote three paragraphs" without
    // repeating either.
    expect(eventLogLine(ONE_OF_EACH["agent.message"]).fields).toMatchObject({ chars: 5 });
    expect(eventLogLine(ONE_OF_EACH["command.output"]).fields).toMatchObject({
      chars: "error: secret token leaked".length,
      stream: "stderr",
    });
  });
});
