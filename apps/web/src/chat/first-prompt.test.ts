import { describe, expect, it } from "vitest";
import { type PromptStorage, stashFirstPrompt, takeFirstPrompt } from "./first-prompt.ts";

function storage(): PromptStorage & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, value),
    removeItem: (key) => void entries.delete(key),
  };
}

describe("the first turn of a new project", () => {
  it("comes back for the project it was written for", () => {
    const store = storage();
    stashFirstPrompt("project-1", { text: "build me a scraper" }, store);

    expect(takeFirstPrompt("project-1", store)).toEqual({ text: "build me a scraper" });
  });

  it("comes back once and only once", () => {
    const store = storage();
    stashFirstPrompt("project-1", { text: "build me a scraper" }, store);

    takeFirstPrompt("project-1", store);
    // Going back to the workspace must not re-send the same message.
    expect(takeFirstPrompt("project-1", store)).toBeUndefined();
    expect(store.entries.size).toBe(0);
  });

  it("leaves another project's prompt where it is", () => {
    const store = storage();
    stashFirstPrompt("project-1", { text: "build me a scraper" }, store);

    expect(takeFirstPrompt("project-2", store)).toBeUndefined();
    // Still there for the workspace it belongs to — consuming it here would lose it.
    expect(takeFirstPrompt("project-1", store)).toEqual({ text: "build me a scraper" });
  });

  it("stashes nothing for an empty prompt", () => {
    const store = storage();
    stashFirstPrompt("project-1", { text: "   " }, store);

    expect(store.entries.size).toBe(0);
  });

  it("discards a stash it cannot read", () => {
    const store = storage();
    store.entries.set("nap.first-prompt", "{ not json");

    expect(takeFirstPrompt("project-1", store)).toBeUndefined();
    expect(store.entries.size).toBe(0);
  });

  it("does nothing at all when there is no storage", () => {
    expect(() => stashFirstPrompt("project-1", { text: "hello" }, undefined)).not.toThrow();
    expect(takeFirstPrompt("project-1", undefined)).toBeUndefined();
  });

  it("keeps the model selected on the dashboard", () => {
    const store = storage();
    stashFirstPrompt(
      "project-1",
      { text: "build me a scraper", model: "anthropic/claude-opus-5" },
      store,
    );

    expect(takeFirstPrompt("project-1", store)).toEqual({
      text: "build me a scraper",
      model: "anthropic/claude-opus-5",
    });
  });

  it("reads a prompt written before model selection existed", () => {
    const store = storage();
    store.entries.set(
      "nap.first-prompt",
      JSON.stringify({ projectId: "project-1", text: "hello" }),
    );

    expect(takeFirstPrompt("project-1", store)).toEqual({ text: "hello" });
  });
});
