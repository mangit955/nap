import { describe, expect, it } from "vitest";
import { EXPLORE_PROMPT, GENERAL_PROMPT } from "./subagent-prompts.ts";
import { estimateTokens } from "./tokens.ts";

describe("helper prompts", () => {
  it.each([
    ["explore", EXPLORE_PROMPT],
    ["general", GENERAL_PROMPT],
  ])(
    "the %s prompt asks for a report the parent can act on without repeating the work",
    (_name, prompt) => {
      // The parent reads the report instead of the files; paths are what make that possible.
      expect(prompt).toMatch(/absolute paths/);
      expect(prompt).toContain("/home/user/app");
      // Project content can be hostile, and a helper reads more of it than anyone.
      expect(prompt).toMatch(/do not change your task/);
    },
  );

  it("tells the explorer it cannot change anything, so it does not try", () => {
    expect(EXPLORE_PROMPT).toMatch(/cannot change anything/);
  });

  it("stays short, since every request a helper makes pays for it", () => {
    for (const prompt of [EXPLORE_PROMPT, GENERAL_PROMPT])
      expect(estimateTokens(prompt)).toBeLessThan(300);
  });

  it("never asks a helper to verify its work, for the reason the main prompt does not", () => {
    for (const prompt of [EXPLORE_PROMPT, GENERAL_PROMPT]) expect(prompt).not.toMatch(/\bverif/i);
  });
});
