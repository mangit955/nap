import type { StoredEvent } from "@nap/shared/ports/event-store";
import { beforeEach, describe, expect, it } from "vitest";
import {
  forgetAllLogs,
  forgetLog,
  REMEMBERED_PROJECTS,
  recallLog,
  rememberLog,
} from "./remembered-logs.ts";

const SESSION = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";

function log(seq: number): StoredEvent[] {
  return [
    {
      type: "agent.message",
      sessionId: SESSION,
      turnId: "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f",
      seq,
      createdAt: "2026-08-09T12:00:00.000Z",
      payload: { text: `message ${seq}` },
    },
  ];
}

beforeEach(forgetAllLogs);

describe("remembered logs", () => {
  it("gives back what was kept for a project, with its session", () => {
    const events = log(3);
    rememberLog("project-a", SESSION, events);

    expect(recallLog("project-a")).toEqual({ sessionId: SESSION, events });
    expect(recallLog("project-b")).toBeUndefined();
  });

  it("keeps the newest log for a project, not the first", () => {
    rememberLog("project-a", SESSION, log(1));
    rememberLog("project-a", SESSION, log(2));

    expect(recallLog("project-a")?.events.at(-1)?.seq).toBe(2);
  });

  it("does not keep an empty log, and an empty one replaces a kept one", () => {
    rememberLog("project-a", SESSION, []);
    expect(recallLog("project-a")).toBeUndefined();

    rememberLog("project-a", SESSION, log(1));
    rememberLog("project-a", SESSION, []);
    expect(recallLog("project-a")).toBeUndefined();
  });

  it("drops the least recently used project past the bound", () => {
    for (let index = 0; index < REMEMBERED_PROJECTS; index += 1)
      rememberLog(`project-${index}`, SESSION, log(1));
    // Using the oldest makes the second oldest the next to go.
    recallLog("project-0");
    rememberLog("project-new", SESSION, log(1));

    expect(recallLog("project-0")).toBeDefined();
    expect(recallLog("project-1")).toBeUndefined();
    expect(recallLog("project-new")).toBeDefined();
  });

  it("forgets one project, or all of them", () => {
    rememberLog("project-a", SESSION, log(1));
    rememberLog("project-b", SESSION, log(1));

    forgetLog("project-a");
    expect(recallLog("project-a")).toBeUndefined();
    expect(recallLog("project-b")).toBeDefined();

    forgetAllLogs();
    expect(recallLog("project-b")).toBeUndefined();
  });
});
