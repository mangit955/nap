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
const OWNER = "owner";
const at = (projectId: string, ownerId = OWNER) => ({ ownerId, projectId });

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
    rememberLog(at("project-a"), SESSION, events);

    expect(recallLog(at("project-a"))).toEqual({ sessionId: SESSION, events });
    expect(recallLog(at("project-b"))).toBeUndefined();
  });

  it("keeps the newest log for a project, not the first", () => {
    rememberLog(at("project-a"), SESSION, log(1));
    rememberLog(at("project-a"), SESSION, log(2));

    expect(recallLog(at("project-a"))?.events.at(-1)?.seq).toBe(2);
  });

  it("does not keep an empty log, and an empty one replaces a kept one", () => {
    rememberLog(at("project-a"), SESSION, []);
    expect(recallLog(at("project-a"))).toBeUndefined();

    rememberLog(at("project-a"), SESSION, log(1));
    rememberLog(at("project-a"), SESSION, []);
    expect(recallLog(at("project-a"))).toBeUndefined();
  });

  it("drops the least recently used project past the bound", () => {
    for (let index = 0; index < REMEMBERED_PROJECTS; index += 1)
      rememberLog(at(`project-${index}`), SESSION, log(1));
    // Using the oldest makes the second oldest the next to go.
    recallLog(at("project-0"));
    rememberLog(at("project-new"), SESSION, log(1));

    expect(recallLog(at("project-0"))).toBeDefined();
    expect(recallLog(at("project-1"))).toBeUndefined();
    expect(recallLog(at("project-new"))).toBeDefined();
  });

  it("gives a log back only to the person it was kept for", () => {
    rememberLog(at("project-a", "first"), SESSION, log(1));

    expect(recallLog(at("project-a", "second"))).toBeUndefined();
    expect(recallLog(at("project-a", "first"))).toBeDefined();
  });

  it("forgets a deleted project for everyone who kept it", () => {
    rememberLog(at("project-a", "first"), SESSION, log(1));
    rememberLog(at("project-a", "second"), SESSION, log(1));
    rememberLog(at("project-b", "first"), SESSION, log(1));

    forgetLog("project-a");

    expect(recallLog(at("project-a", "first"))).toBeUndefined();
    expect(recallLog(at("project-a", "second"))).toBeUndefined();
    expect(recallLog(at("project-b", "first"))).toBeDefined();
  });

  it("forgets one project, or all of them", () => {
    rememberLog(at("project-a"), SESSION, log(1));
    rememberLog(at("project-b"), SESSION, log(1));

    forgetLog("project-a");
    expect(recallLog(at("project-a"))).toBeUndefined();
    expect(recallLog(at("project-b"))).toBeDefined();

    forgetAllLogs();
    expect(recallLog(at("project-b"))).toBeUndefined();
  });
});
