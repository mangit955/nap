import { beforeEach, describe, expect, it, vi } from "vitest";
import { forgetAllLogs, recallLog, rememberLog } from "../hooks/remembered-logs.ts";
import type { ComposerDraftStore } from "../projects/composer-draft.ts";
import { ev, SESSION_ID } from "../testing/events.ts";
import { forgetSignedOut } from "./forget-signed-out.ts";

const KEPT = { ownerId: "owner", projectId: "project-a" };

function drafts() {
  const clearOwner = vi.fn(async (_owner: string) => {});
  return { store: { clearOwner } as unknown as ComposerDraftStore, clearOwner };
}

beforeEach(() => {
  forgetAllLogs();
  sessionStorage.clear();
});

describe("forgetting the person who signed out", () => {
  it("drops every remembered log, their drafts and their composer state", async () => {
    rememberLog(KEPT, SESSION_ID, [ev("agent.message", { text: "kept" }, 1)]);
    sessionStorage.setItem("nap.composer.owner", "{}");
    sessionStorage.setItem("nap.composer.someone-else", "{}");
    const { store, clearOwner } = drafts();

    await forgetSignedOut("owner", store);

    expect(recallLog(KEPT)).toBeUndefined();
    expect(clearOwner).toHaveBeenCalledExactlyOnceWith("owner");
    expect(sessionStorage.getItem("nap.composer.owner")).toBeNull();
    expect(sessionStorage.getItem("nap.composer.someone-else")).toBe("{}");
  });

  it("still drops the logs when nobody is known, or the draft store will not open", async () => {
    rememberLog(KEPT, SESSION_ID, [ev("agent.message", { text: "kept" }, 1)]);
    await forgetSignedOut(undefined, drafts().store);
    expect(recallLog(KEPT)).toBeUndefined();

    rememberLog(KEPT, SESSION_ID, [ev("agent.message", { text: "kept" }, 1)]);
    const failing = { clearOwner: async () => Promise.reject(new Error("no IndexedDB")) };
    await forgetSignedOut("owner", failing as unknown as ComposerDraftStore);
    expect(recallLog(KEPT)).toBeUndefined();
  });
});
