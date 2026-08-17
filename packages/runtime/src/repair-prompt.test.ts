/**
 * What a failed check asks the model.
 *
 * The assertions are on what the prompt *carries* rather than on how it is worded: the name of
 * the check, its detail, and every character the check printed. A repair turn is one of three,
 * and the failure reaching the model intact is the difference between fixing the type error and
 * guessing at it.
 */

import type { RanCheck } from "@nap/verify/run-checks";
import { describe, expect, it } from "vitest";
import { repairCommitSubject, repairPrompt } from "./repair-prompt.ts";
import { failureOf } from "./verify-turn.ts";

const ranTypecheck: RanCheck = {
  name: "typecheck",
  outcome: "failed",
  detail: "exit 2",
  output: {
    stdout: { text: "src/App.tsx(3,10): error TS2304: Cannot find name 'Todo'.", truncated: false },
    stderr: { text: "", truncated: false },
  },
};

/** What the runtime hands the prompt: a run's findings, flattened. */
const failedTypecheck = failureOf(ranTypecheck);

describe("repairPrompt", () => {
  it("names the check that failed and how it failed", () => {
    const prompt = repairPrompt({ failed: failedTypecheck, attempt: 1 });

    expect(prompt).toContain("typecheck");
    expect(prompt).toContain("exit 2");
  });

  it("quotes what the check printed, so the model reads the error rather than a summary", () => {
    const prompt = repairPrompt({ failed: failedTypecheck, attempt: 1 });

    expect(prompt).toContain("src/App.tsx(3,10): error TS2304: Cannot find name 'Todo'.");
  });

  it("keeps both streams, with stderr last", () => {
    // A failing build prints its reason on stderr and its progress on stdout, and losing
    // either half is what made the output worth carrying in the first place.
    const prompt = repairPrompt({
      failed: failureOf({
        name: "build",
        outcome: "failed",
        detail: "exit 1",
        output: {
          stdout: { text: "vite v5 building for production…", truncated: false },
          stderr: { text: "Could not resolve './Todo'", truncated: false },
        },
      }),
      attempt: 2,
    });

    expect(prompt).toContain("vite v5 building for production…");
    expect(prompt.indexOf("Could not resolve")).toBeGreaterThan(prompt.indexOf("vite v5"));
  });

  it("says the check was silent rather than showing an empty quote", () => {
    // A non-zero exit and nothing on either stream. An empty code fence reads as "it said
    // nothing important", which is the opposite of what a silent failure means.
    const prompt = repairPrompt({
      failed: failureOf({ name: "test", outcome: "failed", detail: "exit 1" }),
      attempt: 1,
    });

    expect(prompt).toMatch(/printed nothing/i);
    expect(prompt).toContain("exit 1");
  });

  it("says which attempt this is, because the model cannot see the loop it is in", () => {
    expect(repairPrompt({ failed: failedTypecheck, attempt: 3 })).toContain("3 of 3");
  });

  it("carries the preview's diagnosis, which is all a failed preview has", () => {
    // The preview check runs no command, so its `detail` is the whole finding. A prompt that
    // only quoted output would tell the model its app is broken and nothing else.
    const prompt = repairPrompt({
      failed: failureOf({
        name: "preview",
        outcome: "failed",
        detail: "nothing is listening on port 5173 inside the sandbox",
      }),
      attempt: 1,
    });

    expect(prompt).toContain("nothing is listening on port 5173 inside the sandbox");
  });
});

describe("repairCommitSubject", () => {
  it("says what the commit was for, rather than repeating a paragraph of instructions", () => {
    const subject = repairCommitSubject(failedTypecheck, 2);

    expect(subject).toContain("typecheck");
    expect(subject).toContain("2");
    expect(subject.length).toBeLessThanOrEqual(72);
  });
});
