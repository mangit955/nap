import { expect, it } from "vitest";
import { buildNativePrompt } from "./native-prompt.ts";
import { REPOSITORY_SYSTEM_PROMPT, SYSTEM_PROMPT } from "./system-prompt.ts";

it("sends the new prompt and trusted instructions without assembling API history", () => {
  expect(buildNativePrompt({ prompt: "Build the page" })).toEqual({
    prompt: "Build the page",
    trustedInstructions: SYSTEM_PROMPT,
  });
  expect(buildNativePrompt({ prompt: "Fix it", workspace: "repository" }).trustedInstructions).toBe(
    REPOSITORY_SYSTEM_PROMPT,
  );
});
it("keeps quoted verification context out of the trusted instruction block", () => {
  const result = buildNativePrompt({
    prompt: "Repair it",
    job: { objective: "Build a calendar", attempts: [] },
  });
  expect(result.prompt).toContain("Build a calendar");
  expect(result.trustedInstructions).not.toContain("Build a calendar");
});
