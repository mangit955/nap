import type { NapEvent } from "@nap/shared/events";
import { PROJECT_ROOT_PATH } from "@nap/shared/files-protocol";
import type { StoredEvent } from "@nap/shared/ports/event-store";
import { describe, expect, it } from "vitest";
import { changeCount, changedPaths } from "./changed-paths.ts";

const SESSION = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";
const TURN = "9f8e7d6c-5b4a-4392-8271-605f4e3d2c1b";

let seq = 0;

function event<T extends NapEvent["type"]>(
  type: T,
  payload: Extract<NapEvent, { type: T }>["payload"],
): StoredEvent {
  seq += 1;
  return {
    sessionId: SESSION,
    turnId: TURN,
    seq,
    createdAt: "2026-01-01T00:00:00.000Z",
    type,
    payload,
  } as StoredEvent;
}

function changed(path: string, changeType: "created" | "modified" | "deleted"): StoredEvent {
  return event("file.changed", { path, changeType, diff: "" });
}

describe("changedPaths", () => {
  it("collects the files the agent wrote", () => {
    const paths = changedPaths([
      changed(`${PROJECT_ROOT_PATH}/src/App.tsx`, "modified"),
      changed(`${PROJECT_ROOT_PATH}/src/Counter.tsx`, "created"),
    ]);

    expect([...paths].sort()).toEqual(["src/App.tsx", "src/Counter.tsx"]);
  });

  it("reports them the way the listing does", () => {
    // The tools emit absolute paths and the file endpoints speak relative ones. Without this
    // the sets never intersect and nothing is ever highlighted — silently, since both halves
    // look right on their own.
    const paths = changedPaths([changed(`${PROJECT_ROOT_PATH}/index.html`, "modified")]);

    expect(paths.has("index.html")).toBe(true);
    expect(paths.has(`${PROJECT_ROOT_PATH}/index.html`)).toBe(false);
  });

  it("leaves out deleted files, which are not in the tree to mark", () => {
    const paths = changedPaths([changed(`${PROJECT_ROOT_PATH}/src/Old.tsx`, "deleted")]);

    expect(paths.size).toBe(0);
  });

  it("ignores every other kind of event", () => {
    const paths = changedPaths([
      event("agent.message", { text: "wrote src/App.tsx" }),
      event("turn.started", {}),
    ]);

    expect(paths.size).toBe(0);
  });
});

describe("changeCount", () => {
  it("counts file changes, so a refetch can be triggered by one arriving", () => {
    const events = [
      event("turn.started", {}),
      changed(`${PROJECT_ROOT_PATH}/a.ts`, "created"),
      changed(`${PROJECT_ROOT_PATH}/b.ts`, "deleted"),
    ];

    expect(changeCount(events)).toBe(2);
  });

  it("counts a deletion too", () => {
    // A deleted file is not highlighted, but the listing it left is now wrong — this is the
    // number that decides whether to ask the server again.
    expect(changeCount([changed(`${PROJECT_ROOT_PATH}/gone.ts`, "deleted")])).toBe(1);
  });
});
