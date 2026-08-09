import type { NapEventType } from "@nap/shared/events";
import { describe, expect, it } from "vitest";
import { expectEventSequence } from "./event-assertions.ts";

function stream(...types: NapEventType[]): { type: NapEventType }[] {
  return types.map((type) => ({ type }));
}

describe("expectEventSequence", () => {
  it("passes when the types match exactly, in order", () => {
    expect(() =>
      expectEventSequence(stream("user.message", "turn.started", "turn.completed"), [
        "user.message",
        "turn.started",
        "turn.completed",
      ]),
    ).not.toThrow();
  });

  it("fails when an event is missing", () => {
    expect(() =>
      expectEventSequence(stream("turn.started"), ["turn.started", "turn.completed"]),
    ).toThrow();
  });

  it("fails when the order differs", () => {
    expect(() =>
      expectEventSequence(stream("turn.started", "user.message"), ["user.message", "turn.started"]),
    ).toThrow();
  });

  it("reports both sequences, so a failure says what actually happened", () => {
    // The whole reason this helper exists rather than an index comparison: a diff of two
    // type lists is readable, "expected 'tool.call' to be 'tool.result'" is not.
    let message = "";
    try {
      expectEventSequence(stream("turn.started", "turn.failed"), [
        "turn.started",
        "turn.completed",
      ]);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }

    expect(message).toContain("turn.failed");
    expect(message).toContain("turn.completed");
  });
});
