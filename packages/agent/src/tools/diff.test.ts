import { NapEventSchema } from "@nap/shared/events";
import { describe, expect, it } from "vitest";
import { fileChange } from "./diff.ts";

const PATH = "/home/user/app/src/App.tsx";

describe("fileChange", () => {
  it("calls a file that did not exist created", () => {
    expect(fileChange(PATH, null, "hello\n").changeType).toBe("created");
  });

  it("calls a file that did exist modified", () => {
    expect(fileChange(PATH, "hello\n", "goodbye\n").changeType).toBe("modified");
  });

  it("produces a unified diff naming the file and both sides of the change", () => {
    const { diff } = fileChange(PATH, "one\ntwo\nthree\n", "one\nTWO\nthree\n");

    expect(diff).toContain(PATH);
    expect(diff).toContain("@@");
    expect(diff).toContain("-two");
    expect(diff).toContain("+TWO");
    // Context is what makes the diff readable to whoever is watching the chat pane.
    expect(diff).toContain(" one");
  });

  it("shows every line as added when the file is new", () => {
    const { diff } = fileChange(PATH, null, "alpha\nbeta\n");

    expect(diff).toContain("+alpha");
    expect(diff).toContain("+beta");
    expect(diff).not.toContain("-alpha");
  });

  it("produces an empty diff body when nothing changed", () => {
    // A write that changes nothing is legal and must not invent a hunk.
    expect(fileChange(PATH, "same\n", "same\n").diff).not.toContain("@@");
  });

  it("fits the file.changed payload the event log accepts", () => {
    const event = {
      type: "file.changed",
      sessionId: "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77",
      turnId: "7c9b1a52-8d3e-4f21-a0c4-1b2d3e4f5a6b",
      seq: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
      payload: { path: PATH, ...fileChange(PATH, "a\n", "b\n") },
    };

    expect(NapEventSchema.safeParse(event).success).toBe(true);
  });
});
