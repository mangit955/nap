import { describe, expect, it } from "vitest";
import type { NapEvent } from "./events.ts";
import { ClientFrameSchema, parseClientFrame, ServerFrameSchema, WS_CLOSE } from "./ws-protocol.ts";

const EVENT: NapEvent = {
  type: "agent.message",
  sessionId: "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f",
  turnId: "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f",
  seq: 3,
  createdAt: "2026-08-09T12:00:00.000Z",
  payload: { text: "Added App.tsx." },
};

describe("server frames", () => {
  it("carries an event", () => {
    expect(ServerFrameSchema.safeParse({ type: "event", event: EVENT }).success).toBe(true);
  });

  it("rejects an event frame whose event is not one", () => {
    // The frame is the last place a malformed event could reach a client, and the client
    // parses what it is sent — so the event union is nested here rather than typed loosely.
    const result = ServerFrameSchema.safeParse({
      type: "event",
      event: { ...EVENT, payload: { text: 42 } },
    });
    expect(result.success).toBe(false);
  });

  it("carries a heartbeat and an error", () => {
    expect(ServerFrameSchema.safeParse({ type: "ping" }).success).toBe(true);
    expect(ServerFrameSchema.safeParse({ type: "error", message: "bad frame" }).success).toBe(true);
  });

  it("rejects an unknown frame type and an unknown key", () => {
    expect(ServerFrameSchema.safeParse({ type: "hello" }).success).toBe(false);
    expect(ServerFrameSchema.safeParse({ type: "ping", extra: 1 }).success).toBe(false);
  });

  it("round-trips through JSON unchanged", () => {
    const frame = { type: "event", event: EVENT } as const;
    expect(ServerFrameSchema.parse(JSON.parse(JSON.stringify(frame)))).toStrictEqual(frame);
  });
});

describe("client frames", () => {
  it("accepts a pong", () => {
    expect(ClientFrameSchema.safeParse({ type: "pong" }).success).toBe(true);
  });

  it("rejects anything else", () => {
    expect(ClientFrameSchema.safeParse({ type: "event", event: EVENT }).success).toBe(false);
    expect(ClientFrameSchema.safeParse({ type: "pong", extra: 1 }).success).toBe(false);
  });
});

describe("parseClientFrame", () => {
  it("parses a valid frame from its wire form", () => {
    const result = parseClientFrame('{"type":"pong"}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({ type: "pong" });
  });

  it("reports text that is not JSON without throwing", () => {
    // A client that sends nonsense must not be able to crash the connection handler, so
    // this reports rather than throws — the caller answers with an error frame.
    const result = parseClientFrame("not json at all");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/json/i);
  });

  it("reports JSON that is not a frame", () => {
    const result = parseClientFrame('{"type":"subscribe"}');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message.length).toBeGreaterThan(0);
  });

  it("reports a binary frame rather than guessing at its contents", () => {
    const result = parseClientFrame(new ArrayBuffer(4));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/text/i);
  });
});

describe("close codes", () => {
  it("sit in the range reserved for applications", () => {
    // 1000–2999 are defined by the WebSocket spec and by extensions; 4000–4999 are ours.
    for (const code of Object.values(WS_CLOSE)) {
      expect(code).toBeGreaterThanOrEqual(4000);
      expect(code).toBeLessThanOrEqual(4999);
    }
  });

  it("are distinct, so a client can tell why it was closed", () => {
    const codes = Object.values(WS_CLOSE);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
