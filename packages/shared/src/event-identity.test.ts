import { describe, expect, it } from "vitest";
import { isSameEvent } from "./event-identity.ts";
import type { PendingEvent, StoredEvent } from "./ports/event-store.ts";

const SESSION = "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77";
const OTHER_SESSION = "9f1c7d3e-5b2a-4c8d-9e0f-1a2b3c4d5e6f";
const TURN = "7c9b1a52-8d3e-4f21-a0c4-1b2d3e4f5a6b";
const OTHER_TURN = "1d2e3f40-5a6b-4c7d-8e9f-0a1b2c3d4e5f";

const pending: PendingEvent = {
  type: "agent.message",
  sessionId: SESSION,
  turnId: TURN,
  createdAt: "2026-01-01T00:00:00.000Z",
  payload: { text: "on it" },
};

const stored: StoredEvent = { ...pending, seq: 4 };

describe("recognising an event that has already been written", () => {
  it("matches the same event, whatever seq it was given", () => {
    expect(isSameEvent(pending, stored)).toBe(true);
    expect(isSameEvent(pending, { ...stored, seq: 91 })).toBe(true);
  });

  it("does not match a different payload in the same millisecond of the same turn", () => {
    // Two streamed chunks of one reply agree on everything but their text. Reading the second
    // as a duplicate of the first would drop a line of what the assistant said.
    expect(isSameEvent(pending, { ...stored, payload: { text: "done" } })).toBe(false);
  });

  it("does not match a different type", () => {
    expect(isSameEvent(pending, { ...stored, type: "user.message" } as StoredEvent)).toBe(false);
  });

  it("does not match a different turn or a different session", () => {
    expect(isSameEvent(pending, { ...stored, turnId: OTHER_TURN })).toBe(false);
    expect(isSameEvent(pending, { ...stored, sessionId: OTHER_SESSION })).toBe(false);
  });

  it("does not match the same event emitted at a different moment", () => {
    expect(isSameEvent(pending, { ...stored, createdAt: "2026-01-01T00:00:00.001Z" })).toBe(false);
  });

  it("compares payloads by value rather than by reference", () => {
    // The stored payload came back out of a jsonb column, so it is never the object that went in.
    const nested: PendingEvent = {
      ...pending,
      type: "turn.completed",
      payload: { usage: { inputTokens: 1, outputTokens: 2 }, durationMs: 5, commitSha: null },
    } as PendingEvent;
    const readBack = { ...structuredClone(nested), seq: 1 } as StoredEvent;

    expect(isSameEvent(nested, readBack)).toBe(true);
  });
});
