import { beforeEach, describe, expect, it, vi } from "vitest";
import { accountKey } from "../account/account-cache.ts";
import { forgetAllLogs, recallLog, rememberLog } from "../hooks/remembered-logs.ts";
import type { ComposerDraftStore } from "../projects/composer-draft.ts";
import { knownProject, rememberProjects } from "../projects/known-projects.ts";
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
  it("drops the account's key and models and the project records this tab held", async () => {
    accountKey.set({ configured: true, platform: "openrouter", hint: "sk-or-…4f2a" });
    rememberProjects([
      {
        projectId: "3e0fbc41-6f5d-4a8e-ab9c-4d5e6f708192",
        name: "Their project",
        status: "ready",
        sandboxId: null,
        updatedAt: "2026-08-09T12:30:00.000Z",
        sessionIds: [SESSION_ID],
      },
    ]);

    await forgetSignedOut("owner", drafts().store);

    expect(accountKey.snapshot()).toEqual({ value: undefined, loaded: false });
    expect(knownProject("3e0fbc41-6f5d-4a8e-ab9c-4d5e6f708192")).toBeUndefined();
  });

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
