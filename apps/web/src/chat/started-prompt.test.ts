import { describe, expect, it } from "vitest";
import type { PromptStorage } from "./first-prompt.ts";
import {
  handOffStartedPrompt,
  peekStartedPrompt,
  type StartedPrompt,
  takeStartedPrompt,
} from "./started-prompt.ts";

const KEY = "nap.started-prompt";
const PROJECT = "3e0fbc41-6f5d-4a8e-ab9c-4d5e6f708192";
const OTHER_PROJECT = "4e0fbc41-6f5d-4a8e-ab9c-4d5e6f708192";

const STARTED: StartedPrompt = {
  projectId: PROJECT,
  sessionId: "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f",
  requestId: "e7a1c2d3-4b5a-4c6d-8e9f-0a1b2c3d4e5f",
  text: "Build a habit tracker",
  model: "anthropic/claude-opus-5",
  attachments: [
    {
      kind: "image",
      name: "sketch.png",
      frames: [{ mediaType: "image/jpeg", data: "/9j/DDDD", timestamp: 0 }],
    },
  ],
};

function storage(): PromptStorage & { entries: Map<string, string> } {
  const entries = new Map<string, string>();
  return {
    entries,
    getItem: (key) => entries.get(key) ?? null,
    setItem: (key, value) => void entries.set(key, value),
    removeItem: (key) => void entries.delete(key),
  };
}

describe("a prompt the dashboard already started", () => {
  it("is read back whole by the project it was started for", () => {
    const store = storage();
    handOffStartedPrompt(STARTED, store);

    expect(peekStartedPrompt(PROJECT, store)).toEqual(STARTED);
    expect(takeStartedPrompt(PROJECT, store)).toEqual(STARTED);
  });

  it("is taken once: a peek leaves it, a take removes it", () => {
    const store = storage();
    handOffStartedPrompt(STARTED, store);

    peekStartedPrompt(PROJECT, store);
    expect(store.entries.has(KEY)).toBe(true);
    takeStartedPrompt(PROJECT, store);
    // Coming back to the workspace later must not show a prompt the log already has.
    expect(takeStartedPrompt(PROJECT, store)).toBeUndefined();
    expect(store.entries.size).toBe(0);
  });

  it("leaves another project's where it is", () => {
    const store = storage();
    handOffStartedPrompt(STARTED, store);

    expect(peekStartedPrompt(OTHER_PROJECT, store)).toBeUndefined();
    expect(takeStartedPrompt(OTHER_PROJECT, store)).toBeUndefined();
    expect(takeStartedPrompt(PROJECT, store)).toEqual(STARTED);
  });

  it("discards one it cannot read, and never shows it", () => {
    const store = storage();
    store.entries.set(KEY, JSON.stringify({ ...STARTED, requestId: "not-a-request" }));

    expect(peekStartedPrompt(PROJECT, store)).toBeUndefined();
    expect(takeStartedPrompt(PROJECT, store)).toBeUndefined();
    expect(store.entries.size).toBe(0);

    store.entries.set(KEY, "{ not json");
    expect(takeStartedPrompt(PROJECT, store)).toBeUndefined();
    expect(store.entries.size).toBe(0);
  });

  it("never throws when the browser will not store it", () => {
    // The start already succeeded; a full or disabled storage costs the early bubble, never the
    // navigation to the project.
    const full: PromptStorage = {
      getItem: () => null,
      setItem: () => {
        throw new DOMException("quota", "QuotaExceededError");
      },
      removeItem: () => {},
    };

    expect(() => handOffStartedPrompt(STARTED, full)).not.toThrow();
    expect(() => handOffStartedPrompt(STARTED, undefined)).not.toThrow();
  });
});
