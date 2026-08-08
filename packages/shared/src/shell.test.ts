import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { shellQuote } from "./shell.ts";

describe("shellQuote", () => {
  // The text being quoted is written by a model and interpolated into a command line, so
  // this is the boundary between "the agent named something" and "the agent ran a command".
  //
  // Asserted against a real shell rather than against an expected string. What matters is
  // not that the output looks a particular way, it is that `sh` parses it back to exactly
  // the input and executes nothing along the way — and only `sh` can settle that. This is
  // still deterministic, offline and instant, so it stays a unit test.
  function throughShell(value: string): string {
    return execFileSync("sh", ["-c", `printf %s ${shellQuote(value)}`], { encoding: "utf8" });
  }

  it("escapes embedded single quotes so the string cannot be closed early", () => {
    // The classic break-out: a bare ' would end the quoted region and leave the rest as
    // shell. The POSIX-portable escape is to close, emit a literal quote, and reopen.
    expect(shellQuote("it's")).toBe("'it'\\''s'");
  });

  it.each([
    ["plain text", "Add login form"],
    ["command substitution", "$(touch /tmp/pwned)"],
    ["backticks", "`whoami`"],
    ["a quote-then-command payload", "'; rm -rf /; echo '"],
    ["double quotes", 'say "hello"'],
    ["a newline", "line one\nline two"],
    ["shell metacharacters", "a && b || c | d > e < f & g; h"],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell expansion is the input under test.
    ["variable expansion", "$HOME and ${PATH}"],
    ["a backslash", "back\\slash"],
    ["an empty string", ""],
  ])("survives a round trip through sh: %s", (_name, value) => {
    expect(throughShell(value)).toBe(value);
  });

  it("does not execute a substitution payload", () => {
    // Belt and braces on the case that matters most: if the quoting leaked, the shell
    // would run `id` and the output would differ from the literal text.
    expect(throughShell("$(id)")).toBe("$(id)");
  });
});
