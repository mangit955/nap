import type { StoredEvent } from "@nap/shared/ports/event-store";
import type { MemoryProvider } from "@nap/shared/ports/memory-provider";
import { describe, expect, it } from "vitest";
import { NoopMemoryProvider } from "./noop-memory-provider.ts";

const SESSION = "6f1c1d3e-2b7a-4c5e-8f9a-0d1e2f3a4b5c";

function storedEvents(): StoredEvent[] {
  return [
    {
      type: "user.message",
      sessionId: SESSION,
      turnId: "1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d",
      seq: 1,
      createdAt: "2026-08-07T12:00:00.000Z",
      payload: { text: "add a dark mode toggle" },
    },
    {
      type: "agent.message",
      sessionId: SESSION,
      turnId: "1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d",
      seq: 2,
      createdAt: "2026-08-07T12:00:05.000Z",
      payload: { text: "Added a toggle to the header." },
    },
  ];
}

/**
 * Stands in for the way `ContextEngine` calls the seam: ask for memories, and interpolate
 * them only when there are any. Defined here because the real consumer does not exist
 * yet; once it does, it makes the same assertion against itself (docs/PLAN.md §4).
 */
async function buildPrompt(base: string, memory?: MemoryProvider): Promise<string> {
  const memories = (await memory?.retrieve(SESSION, "dark mode")) ?? [];
  if (memories.length === 0) return base;
  return `${base}\n\n<memories>\n${memories.map((m) => m.content).join("\n")}\n</memories>`;
}

describe("NoopMemoryProvider", () => {
  describe("retrieve", () => {
    it("returns an empty list", async () => {
      const memory = new NoopMemoryProvider();

      expect(await memory.retrieve(SESSION, "dark mode")).toEqual([]);
    });

    it("returns an empty list for an unknown session and an empty query", async () => {
      const memory = new NoopMemoryProvider();

      expect(await memory.retrieve("not-a-session", "")).toEqual([]);
    });

    it("never answers with null or undefined", async () => {
      // A caller forced to null-check the seam is a caller that will eventually
      // interpolate `undefined` into a prompt. An empty array has no such edge.
      const memory = new NoopMemoryProvider();
      const result = await memory.retrieve(SESSION, "anything");

      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe("write", () => {
    it("accepts an empty list without throwing", async () => {
      const memory = new NoopMemoryProvider();

      await expect(memory.write(SESSION, [])).resolves.toBeUndefined();
    });

    it("accepts real events without throwing", async () => {
      const memory = new NoopMemoryProvider();

      await expect(memory.write(SESSION, storedEvents())).resolves.toBeUndefined();
    });

    it("stores nothing — a write is not readable afterwards", async () => {
      // The half that matters. "Did not throw" alone would pass against an
      // implementation that quietly retained everything, which is the opposite of inert.
      const memory = new NoopMemoryProvider();

      await memory.write(SESSION, storedEvents());

      expect(await memory.retrieve(SESSION, "dark mode")).toEqual([]);
      expect(await memory.retrieve(SESSION, "")).toEqual([]);
    });

    it("does not mutate the events it is handed", async () => {
      const memory = new NoopMemoryProvider();
      const events = storedEvents();

      await memory.write(SESSION, events);

      expect(events).toEqual(storedEvents());
    });
  });

  describe("as a seam", () => {
    it("leaves a consumer identical to one given no provider at all", async () => {
      // This is the whole point of the task: the call sites are real from v1, and turning
      // memory on in v2 must be a change of implementation rather than a change of shape.
      const base = "You are editing a React project.";

      const withNoop = await buildPrompt(base, new NoopMemoryProvider());
      const withNothing = await buildPrompt(base);

      expect(withNoop).toBe(withNothing);
      expect(withNoop).toBe(base);
    });

    it("leaves a consumer identical even after events have been written", async () => {
      const base = "You are editing a React project.";
      const memory = new NoopMemoryProvider();

      await memory.write(SESSION, storedEvents());

      expect(await buildPrompt(base, memory)).toBe(await buildPrompt(base));
    });

    it("is what a real provider would displace, not a special case", async () => {
      // Guards the parity assertions above against becoming vacuous: the same consumer
      // demonstrably *does* change its output when a provider returns something, so the
      // no-op tests are measuring inertness rather than a consumer that ignores memory.
      const stub: MemoryProvider = {
        retrieve: async () => [{ id: "m1", content: "the user prefers tabs", score: 1 }],
        write: async () => {},
      };
      const base = "You are editing a React project.";

      expect(await buildPrompt(base, stub)).not.toBe(base);
      expect(await buildPrompt(base, stub)).toContain("the user prefers tabs");
    });
  });
});
