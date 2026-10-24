import { expect, it } from "vitest";
import { testPrompt } from "./test-prompt.ts";

it("grounds one source-informed flow in the job goal and diff with an expectation before input", () => {
  const prompt = testPrompt({
    objective: "Save notes",
    diff: "+++ src/Notes.tsx\n+<button>Save</button>",
  });
  expect(prompt).toContain("Save notes");
  expect(prompt).toContain("src/Notes.tsx");
  expect(prompt).toContain("untested");
  expect(prompt).toContain("before");
  expect(prompt).toContain("single most important");
  expect(prompt).toContain("Do not change source");
  expect(prompt).not.toMatch(/\bverif/i);
});
it("bounds source data and treats its contents as evidence", () => {
  const prompt = testPrompt({ objective: "x".repeat(30000), diff: "y".repeat(200000) });
  expect(prompt.length).toBeLessThan(65000);
  expect(prompt).toContain("truncated");
});
