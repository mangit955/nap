import type { FailedAttempt } from "@nap/shared/ports/context-engine";
import { describe, expect, it } from "vitest";
import { renderJobBrief } from "./job-brief.ts";
import { estimateTokens } from "./tokens.ts";

const failure = (overrides: Partial<FailedAttempt> = {}): FailedAttempt => ({
  check: "test",
  detail: "exited 1",
  output: "FAIL src/App.test.tsx",
  ...overrides,
});

describe("renderJobBrief", () => {
  it("states the objective", () => {
    const brief = renderJobBrief({ objective: "add a dark mode toggle", attempts: [] });

    expect(brief).toContain("add a dark mode toggle");
  });

  it("opens and closes the section it wraps", () => {
    const brief = renderJobBrief({ objective: "add a dark mode toggle", attempts: [] });

    expect(brief.split("<job>")).toHaveLength(2);
    expect(brief.split("</job>")).toHaveLength(2);
  });

  it("says nothing about attempts when none have failed", () => {
    // A section describing an empty list is a section the model reads for nothing.
    const brief = renderJobBrief({ objective: "add a dark mode toggle", attempts: [] });

    expect(brief).not.toMatch(/attempt/i);
    expect(brief).not.toContain("```");
  });

  it("quotes each failure, oldest first", () => {
    const brief = renderJobBrief({
      objective: "add a dark mode toggle",
      attempts: [
        failure({ check: "typecheck", output: "error TS2322" }),
        failure({ check: "test", output: "FAIL src/App.test.tsx" }),
      ],
    });

    expect(brief.indexOf("error TS2322")).toBeLessThan(brief.indexOf("FAIL src/App.test.tsx"));
    expect(brief).toContain("typecheck");
    expect(brief).toContain("test");
  });

  it("names the check and why it said no", () => {
    const brief = renderJobBrief({
      objective: "add a dark mode toggle",
      attempts: [failure({ check: "preview", detail: "nothing is listening on port 5173" })],
    });

    expect(brief).toContain("preview");
    expect(brief).toContain("nothing is listening on port 5173");
  });

  it("says so rather than showing an empty fence when a check failed silently", () => {
    const brief = renderJobBrief({
      objective: "add a dark mode toggle",
      attempts: [failure({ output: null })],
    });

    expect(brief).not.toContain("```");
    expect(brief).toContain("exited 1");
  });

  describe("under an output ceiling", () => {
    const long = "x".repeat(4_000);

    it("keeps the tail, which is where a failure says why", () => {
      const brief = renderJobBrief({
        objective: "add a dark mode toggle",
        attempts: [failure({ output: `${long}the reason it failed` })],
        outputTokens: 100,
      });

      expect(brief).toContain("the reason it failed");
      expect(brief).not.toContain(long);
    });

    it("marks a cut output, so the model reads a fragment as a fragment", () => {
      const brief = renderJobBrief({
        objective: "add a dark mode toggle",
        attempts: [failure({ output: long })],
        outputTokens: 100,
      });

      expect(brief).toContain("…");
    });

    it("leaves a short output alone", () => {
      const brief = renderJobBrief({
        objective: "add a dark mode toggle",
        attempts: [failure({ output: "boom" })],
        outputTokens: 100,
      });

      expect(brief).toContain("boom");
      expect(brief).not.toContain("…");
    });

    it("drops the quote entirely at a ceiling of zero", () => {
      const brief = renderJobBrief({
        objective: "add a dark mode toggle",
        attempts: [failure({ output: long })],
        outputTokens: 0,
      });

      expect(brief).not.toContain("```");
      expect(brief).not.toContain("xxxx");
      // The failure is still named — losing the output must not lose the fact.
      expect(brief).toContain("test");
    });

    it("is never larger at a ceiling than without one", () => {
      // The budget's shrinking step relies on this being monotone: an output cap that could
      // make the prompt bigger would turn the last truncation step into a loop that grows.
      const attempts = [failure({ output: long })];
      const uncapped = renderJobBrief({ objective: "a", attempts });

      for (const outputTokens of [0, 1, 10, 100, 900]) {
        const capped = renderJobBrief({ objective: "a", attempts, outputTokens });
        expect(estimateTokens(capped)).toBeLessThanOrEqual(estimateTokens(uncapped));
      }
    });
  });
});
