import { describe, expect, it } from "vitest";
import {
  type CommandOutput,
  captureCommandOutput,
  OUTPUT_LIMIT_PER_STREAM,
} from "./command-output.ts";

/**
 * Narrows away the absent case, which most of these tests are not about.
 *
 * A helper rather than `!` at each site: the one test that *is* about absence asserts it
 * directly, and everywhere else a silently-undefined capture should fail as a sentence rather
 * than as a property access on undefined three lines later.
 */
function captured(streams: { stdout: string; stderr: string }): CommandOutput {
  const output = captureCommandOutput(streams);
  if (output === undefined) throw new Error("expected output to have been captured");
  return output;
}

describe("captureCommandOutput", () => {
  it("keeps short output whole and says it was not truncated", () => {
    expect(captured({ stdout: "built in 1.2s", stderr: "" })).toEqual({
      stdout: { text: "built in 1.2s", truncated: false },
      stderr: { text: "", truncated: false },
    });
  });

  it("keeps the tail rather than the head when there is too much", () => {
    // The reason a failing command is being read at all is at the *end* of its output: the
    // error, the stack, the summary line. A head-biased cut keeps the banner and loses all of
    // that, which would make the captured output look complete and explain nothing.
    const long = `${"a".repeat(OUTPUT_LIMIT_PER_STREAM)}THE ACTUAL ERROR`;

    const output = captured({ stdout: long, stderr: "" });

    expect(output.stdout.text.endsWith("THE ACTUAL ERROR")).toBe(true);
    expect(output.stdout.text.length).toBe(OUTPUT_LIMIT_PER_STREAM);
    expect(output.stdout.truncated).toBe(true);
  });

  it("budgets each stream on its own, so a chatty stdout cannot starve stderr", () => {
    // The case this exists for. A build that dumps its progress to stdout and its reason to
    // stderr must not lose the reason, and a shared budget consumed in order would do exactly
    // that — the failure would be recorded as a wall of progress bars.
    const output = captured({
      stdout: "x".repeat(OUTPUT_LIMIT_PER_STREAM * 4),
      stderr: 'Script not found "lint"',
    });

    expect(output.stdout.truncated).toBe(true);
    expect(output.stderr.text).toBe('Script not found "lint"');
    expect(output.stderr.truncated).toBe(false);
  });

  it("does not call output that exactly fills the budget truncated", () => {
    // Off by one here would mark every full-but-intact capture as a fragment, which teaches a
    // reader to distrust the flag on the captures that really are fragments.
    const exact = "y".repeat(OUTPUT_LIMIT_PER_STREAM);

    const output = captured({ stdout: exact, stderr: "" });

    expect(output.stdout.truncated).toBe(false);
    expect(output.stdout.text).toBe(exact);
  });

  it("is absent entirely when the command said nothing at all", () => {
    // A pair of empty strings is not evidence; recording it puts two empty objects into every
    // failed check that produced no output, which is noise in an artefact people diff.
    expect(captureCommandOutput({ stdout: "", stderr: "" })).toBeUndefined();
  });
});
