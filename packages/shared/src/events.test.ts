import { describe, expect, it } from "vitest";
import { type NapEvent, NapEventSchema } from "./events.ts";

/**
 * Every event type gets four assertions: it parses, it rejects a malformed fixture at a
 * named path, it discriminates, and it survives a JSON round trip unchanged.
 *
 * One case per type drives all four blocks, so coverage is structural rather than clerical —
 * you cannot add a type without adding its case (see "the case table covers the union").
 */

const ENVELOPE = {
  sessionId: "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f",
  turnId: "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f",
  seq: 0,
  createdAt: "2026-08-07T12:00:00.000Z",
} as const;

const JOB_ID = "3f9a1c2d-5e6b-4f7a-8b9c-0d1e2f3a4b5c";

type Case = {
  readonly type: NapEvent["type"];
  readonly valid: NapEvent;
  /** `valid` with exactly one field broken — one fixture, one reason to fail. */
  readonly malformed: unknown;
  /** Where `malformed`'s first issue must point. Asserted, not just "it threw". */
  readonly issuePath: readonly (string | number)[];
};

const CASES = [
  {
    type: "user.message",
    valid: { ...ENVELOPE, type: "user.message", payload: { text: "build me a todo list" } },
    malformed: { ...ENVELOPE, type: "user.message", payload: { text: 42 } },
    issuePath: ["payload", "text"],
  },
  {
    type: "agent.thinking",
    valid: { ...ENVELOPE, type: "agent.thinking", payload: { text: "considering the layout" } },
    malformed: { ...ENVELOPE, type: "agent.thinking", payload: {} },
    issuePath: ["payload", "text"],
  },
  {
    type: "agent.message",
    valid: { ...ENVELOPE, type: "agent.message", payload: { text: "Added App.tsx." } },
    malformed: { ...ENVELOPE, type: "agent.message", payload: { text: null } },
    issuePath: ["payload", "text"],
  },
  {
    type: "tool.call",
    valid: {
      ...ENVELOPE,
      type: "tool.call",
      payload: {
        toolCallId: "call_1",
        toolName: "write_file",
        input: { path: "src/App.tsx", content: "export default () => null;" },
      },
    },
    // A tool name outside the six proxy tools must not reach the event log.
    malformed: {
      ...ENVELOPE,
      type: "tool.call",
      payload: { toolCallId: "call_1", toolName: "rm_rf", input: {} },
    },
    issuePath: ["payload", "toolName"],
  },
  {
    type: "tool.result",
    valid: {
      ...ENVELOPE,
      type: "tool.result",
      payload: { toolCallId: "call_1", toolName: "write_file", ok: true, output: "wrote 2 lines" },
    },
    malformed: {
      ...ENVELOPE,
      type: "tool.result",
      payload: { toolCallId: "call_1", toolName: "write_file", ok: "yes", output: "" },
    },
    issuePath: ["payload", "ok"],
  },
  {
    type: "file.changed",
    valid: {
      ...ENVELOPE,
      type: "file.changed",
      payload: {
        path: "src/App.tsx",
        changeType: "modified",
        diff: "@@ -1 +1 @@\n-old\n+new\n",
      },
    },
    malformed: {
      ...ENVELOPE,
      type: "file.changed",
      payload: { path: "src/App.tsx", changeType: "renamed", diff: "" },
    },
    issuePath: ["payload", "changeType"],
  },
  {
    type: "command.output",
    valid: {
      ...ENVELOPE,
      type: "command.output",
      payload: { toolCallId: "call_1", stream: "stdout", chunk: "vite v6.0.0 ready\n" },
    },
    malformed: {
      ...ENVELOPE,
      type: "command.output",
      payload: { toolCallId: "call_1", stream: "stdlog", chunk: "" },
    },
    issuePath: ["payload", "stream"],
  },
  {
    type: "preview.ready",
    valid: {
      ...ENVELOPE,
      type: "preview.ready",
      payload: { url: "https://5173-abc.e2b.dev", port: 5173 },
    },
    malformed: {
      ...ENVELOPE,
      type: "preview.ready",
      payload: { url: "not a url", port: 5173 },
    },
    issuePath: ["payload", "url"],
  },
  {
    type: "preview.stopped",
    valid: { ...ENVELOPE, type: "preview.stopped", payload: {} },
    // Nothing in the payload to break, so the envelope stands in — the same fixture
    // `turn.started` uses, and for the same reason.
    malformed: { ...ENVELOPE, sessionId: "not-a-uuid", type: "preview.stopped", payload: {} },
    issuePath: ["sessionId"],
  },
  {
    type: "turn.started",
    valid: { ...ENVELOPE, type: "turn.started", payload: { source: "verification" } },
    // The envelope is part of every member's contract, so break it here.
    malformed: { ...ENVELOPE, seq: -1, type: "turn.started", payload: { source: "user" } },
    issuePath: ["seq"],
  },
  {
    type: "turn.completed",
    valid: {
      ...ENVELOPE,
      type: "turn.completed",
      payload: {
        usage: { inputTokens: 1200, outputTokens: 340 },
        durationMs: 8_400,
        commitSha: "a1b2c3d",
      },
    },
    malformed: {
      ...ENVELOPE,
      type: "turn.completed",
      payload: {
        usage: { inputTokens: 1200.5, outputTokens: 340 },
        durationMs: 8_400,
        commitSha: null,
      },
    },
    issuePath: ["payload", "usage", "inputTokens"],
  },
  {
    type: "turn.failed",
    valid: {
      ...ENVELOPE,
      type: "turn.failed",
      payload: { reason: "budget_exceeded", message: "step budget of 40 exceeded" },
    },
    malformed: {
      ...ENVELOPE,
      type: "turn.failed",
      payload: { reason: "vibes", message: "" },
    },
    issuePath: ["payload", "reason"],
  },
  {
    type: "system.notice",
    valid: {
      ...ENVELOPE,
      type: "system.notice",
      payload: { level: "warning", text: "Could not restore the last snapshot." },
    },
    malformed: {
      ...ENVELOPE,
      type: "system.notice",
      payload: { level: "shout", text: "something happened" },
    },
    issuePath: ["payload", "level"],
  },
  {
    type: "job.started",
    valid: {
      ...ENVELOPE,
      type: "job.started",
      payload: { jobId: JOB_ID, objective: "build me a todo list" },
    },
    // A job with no objective is a job nothing can be verified against.
    malformed: { ...ENVELOPE, type: "job.started", payload: { jobId: JOB_ID, objective: "" } },
    issuePath: ["payload", "objective"],
  },
  {
    type: "verification.started",
    valid: { ...ENVELOPE, type: "verification.started", payload: { jobId: JOB_ID } },
    malformed: { ...ENVELOPE, type: "verification.started", payload: { jobId: "job-1" } },
    issuePath: ["payload", "jobId"],
  },
  {
    type: "verification.completed",
    valid: {
      ...ENVELOPE,
      type: "verification.completed",
      payload: {
        jobId: JOB_ID,
        checks: [
          { name: "typecheck", outcome: "passed", output: null },
          { name: "lint", outcome: "failed", output: "1 error" },
          // Short-circuiting: everything after the first failure was never asked.
          { name: "build", outcome: "absent", output: null },
        ],
      },
    },
    // `skipped` is the boolean-shaped answer the three outcomes exist to refuse.
    malformed: {
      ...ENVELOPE,
      type: "verification.completed",
      payload: { jobId: JOB_ID, checks: [{ name: "lint", outcome: "skipped", output: null }] },
    },
    issuePath: ["payload", "checks", 0, "outcome"],
  },
  {
    type: "job.checkpointed",
    valid: {
      ...ENVELOPE,
      type: "job.checkpointed",
      payload: { jobId: JOB_ID, commitSha: "9f1c2b3" },
    },
    malformed: {
      ...ENVELOPE,
      type: "job.checkpointed",
      payload: { jobId: JOB_ID, commitSha: "" },
    },
    issuePath: ["payload", "commitSha"],
  },
  {
    type: "job.completed",
    valid: { ...ENVELOPE, type: "job.completed", payload: { jobId: JOB_ID, outcome: "verified" } },
    malformed: {
      ...ENVELOPE,
      type: "job.completed",
      payload: { jobId: JOB_ID, outcome: "done" },
    },
    issuePath: ["payload", "outcome"],
  },
] as const satisfies readonly Case[];

function byType(type: NapEvent["type"]): Case {
  const found = CASES.find((c) => c.type === type);
  if (found === undefined) throw new Error(`no case for ${type}`);
  return found;
}

describe("the case table covers the union", () => {
  it("has one case per event type, with no duplicates and none missing", () => {
    const covered = CASES.map((c) => c.type);
    expect(new Set(covered).size).toBe(covered.length);
    expect(CASES).toHaveLength(NapEventSchema.options.length);

    // Fails to compile if a new member is added to the union without a case here.
    const _exhaustive: (typeof CASES)[number]["type"] = null as unknown as NapEvent["type"];
    void _exhaustive;
  });
});

describe.each(CASES)("$type", ({ type, valid, malformed, issuePath }) => {
  it("parses a valid fixture", () => {
    expect(NapEventSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a malformed fixture with a useful issue path", () => {
    const result = NapEventSchema.safeParse(malformed);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.issues[0]?.path).toEqual([...issuePath]);
  });

  it("discriminates to the right union member", () => {
    expect(NapEventSchema.parse(valid).type).toBe(type);

    // Pairing this type with a structurally foreign payload must fail — that is what
    // proves the union discriminates rather than passing anything through. The partner
    // has to be picked deliberately: user.message, agent.thinking and agent.message all
    // carry `{ text }` and so are interchangeable at the payload level by design, which
    // is exactly what the assertion above covers for them.
    const partner = type === "tool.call" ? byType("user.message") : byType("tool.call");
    const mismatched = { ...ENVELOPE, type, payload: partner.valid.payload };
    expect(NapEventSchema.safeParse(mismatched).success).toBe(false);
  });

  it("round-trips through JSON unchanged", () => {
    // toStrictEqual, not toEqual: toEqual treats a dropped `undefined` key as equal
    // to a present one, which is exactly the Postgres jsonb bug this assertion exists
    // to catch. Nothing in an event payload may rely on `undefined` surviving.
    const roundTripped = NapEventSchema.parse(JSON.parse(JSON.stringify(valid)));
    expect(roundTripped).toStrictEqual(valid);
  });
});

describe("turn.started's prompt source", () => {
  it("reads a payload written before the field existed as the user's", () => {
    // Every `turn.started` in the log predating repairs has an empty payload, and replay parses
    // the rows it finds rather than the rows it wishes it had. A required field here would make
    // a session written last week unreadable this week.
    const parsed = NapEventSchema.parse({ ...ENVELOPE, type: "turn.started", payload: {} });

    expect(parsed.payload).toStrictEqual({ source: "user" });
  });

  it("refuses a source that is neither the user nor the verifier", () => {
    const result = NapEventSchema.safeParse({
      ...ENVELOPE,
      type: "turn.started",
      payload: { source: "model" },
    });

    expect(result.success).toBe(false);
  });
});
