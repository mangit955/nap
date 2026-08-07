import { describe, expect, it } from "vitest";
import { type NapEvent, NapEventSchema } from "./events.ts";

/**
 * The M0-3 gate: 11 event types × 4 assertions (docs/PLAN.md §4, `nap-events` skill).
 *
 * One case per event type drives all four blocks, so the count is structural rather
 * than clerical — you cannot add a type without adding its case (see "the case table
 * covers the union" below).
 */

const ENVELOPE = {
  sessionId: "sess_1",
  turnId: "turn_1",
  seq: 0,
  createdAt: "2026-08-07T12:00:00.000Z",
} as const;

type Case = {
  /** The `type` discriminator this case covers. */
  readonly type: NapEvent["type"];
  /** A fully valid event. */
  readonly valid: NapEvent;
  /** The same event with exactly one field broken. */
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
    // A tool name outside the six M2-5 defines must not reach the event log.
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
    type: "turn.started",
    valid: { ...ENVELOPE, type: "turn.started", payload: {} },
    // The envelope is part of every member's contract, so break it here.
    malformed: { ...ENVELOPE, seq: -1, type: "turn.started", payload: {} },
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
    expect(CASES).toHaveLength(11);

    // Fails to compile if a 12th member is added to the union without a case here.
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
