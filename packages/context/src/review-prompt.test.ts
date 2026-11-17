import { describe, expect, it } from "vitest";
import { REVIEW_PROMPT, REVIEW_PROMPTS, reviewTask } from "./review-prompt.ts";

describe("reviewTask", () => {
  it("quotes the request and lists the changed files", () => {
    expect(reviewTask({ objective: "Do X.", changedFiles: ["a.py", "b.py"] })).toBe(
      "The request the agent was given:\n\n<request>\nDo X.\n</request>\n\nFiles the agent changed:\n- a.py\n- b.py",
    );
  });

  it("says where to look when no file list is known", () => {
    expect(reviewTask({ objective: "Do X.", changedFiles: [] })).toContain(
      "look at it as it is now",
    );
  });
});

describe("REVIEW_PROMPT", () => {
  it("asks for the report in the shape the reviewer's check reads", () => {
    // `@nap/agent/reviewer` blocks only on a problem whose `command` it ran and whose `observed`
    // that command printed; a prompt that stopped asking for either would block on nothing.
    for (const field of ['"problems"', '"command"', '"observed"', '"notes"'])
      expect(REVIEW_PROMPT).toContain(field);
    expect(REVIEW_PROMPTS).toEqual({ system: REVIEW_PROMPT, task: reviewTask });
  });
});
