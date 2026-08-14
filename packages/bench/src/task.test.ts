import { describe, expect, it } from "vitest";
import { parseBenchTask } from "./task.ts";

const valid = {
  id: "landing-page",
  name: "A landing page",
  prompt: "Build a landing page with a headline and a call to action.",
  checks: [{ id: "build", kind: "command", command: "bun run build" }],
};

describe("parseBenchTask", () => {
  it("accepts a well-formed task", () => {
    const parsed = parseBenchTask(valid);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.value.checks[0]?.command).toBe("bun run build");
  });

  it("rejects a task with no checks, which could never produce a score", () => {
    const parsed = parseBenchTask({ ...valid, checks: [] });
    expect(parsed.ok).toBe(false);
  });

  it("rejects an empty prompt", () => {
    expect(parseBenchTask({ ...valid, prompt: "" }).ok).toBe(false);
  });

  it("rejects an unknown check kind rather than skipping it", () => {
    // A check nobody executes would silently not count towards the score, and the run
    // would look like it passed everything that was asked of it.
    const parsed = parseBenchTask({
      ...valid,
      checks: [{ id: "a11y", kind: "accessibility", command: "x" }],
    });
    expect(parsed.ok).toBe(false);
  });

  it("rejects an unknown field, so a mistyped key is not silently ignored", () => {
    // `weight` and `required` are real fields in the specification but do not exist yet.
    // Accepting them now would mean a task file that reads as weighted, and is not.
    const parsed = parseBenchTask({ ...valid, weight: 3 });
    expect(parsed.ok).toBe(false);
  });

  it("rejects two checks sharing an id, which would make a result ambiguous", () => {
    const parsed = parseBenchTask({
      ...valid,
      checks: [
        { id: "build", kind: "command", command: "bun run build" },
        { id: "build", kind: "command", command: "bun run lint" },
      ],
    });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("build");
  });

  it("explains what was wrong rather than failing bare", () => {
    const parsed = parseBenchTask({ ...valid, prompt: 42 });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("prompt");
  });
});
