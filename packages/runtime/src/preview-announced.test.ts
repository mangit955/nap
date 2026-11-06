import type { NapEventType } from "@nap/shared/events";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { describe, expect, it } from "vitest";
import { shouldAnnouncePreview } from "./preview-announced.ts";

const SESSION = "3e4f5a6b-7c8d-4e9f-8a0b-1c2d3e4f5a6b";
const TURN = "8c9d0e1f-2a3b-4c4d-8e5f-6a7b8c9d0e1f";

const PAYLOADS: Partial<Record<NapEventType, unknown>> = {
  "user.message": { text: "build me a todo list" },
  "preview.ready": { url: "https://5173-sandbox.sandbox.invalid", port: 5173 },
  "preview.stopped": {},
  "turn.failed": { reason: "cancelled", message: "The turn was cancelled." },
};

function log(...types: NapEventType[]): StoredEvent[] {
  return types.map(
    (type, index) =>
      ({
        type,
        sessionId: SESSION,
        turnId: TURN,
        seq: index + 1,
        createdAt: "2026-11-06T00:00:00.000Z",
        payload: PAYLOADS[type] ?? {},
      }) as StoredEvent,
  );
}

describe("shouldAnnouncePreview", () => {
  it("announces a sandbox this call created, whatever the log says", () => {
    expect(shouldAnnouncePreview({ created: true, history: log() })).toBe(true);
    expect(shouldAnnouncePreview({ created: true, history: log("preview.ready") })).toBe(true);
  });

  it("leaves alone a live sandbox the log already announced", () => {
    expect(
      shouldAnnouncePreview({ created: false, history: log("user.message", "preview.ready") }),
    ).toBe(false);
    expect(
      shouldAnnouncePreview({
        created: false,
        history: log("preview.ready", "preview.stopped", "preview.ready", "user.message"),
      }),
    ).toBe(false);
  });

  it("announces a live sandbox the log never announced — its creating turn was cancelled first", () => {
    expect(
      shouldAnnouncePreview({ created: false, history: log("user.message", "turn.failed") }),
    ).toBe(true);
  });

  it("announces when the newest announcement belongs to a sandbox that has since stopped", () => {
    expect(
      shouldAnnouncePreview({
        created: false,
        history: log("preview.ready", "user.message", "preview.stopped", "user.message"),
      }),
    ).toBe(true);
  });
});
