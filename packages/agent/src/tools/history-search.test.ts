import { afterEach, describe, expect, it } from "vitest";
import { LocalShellSandbox } from "../testing/local-shell-sandbox.ts";
import type { ToolContext } from "./context.ts";
import { PROJECT_ROOT } from "./definitions.ts";
import { executeTool } from "./execute.ts";

/**
 * The search the compaction history's pointer tells the agent to make: `search_files` given one
 * file rather than a directory, with a pattern anchored on an entry's number, then `read_file` at
 * the line that reported.
 *
 * A literal copy of the file's shape, because this package must not depend on the one that
 * renders it. The lines that matter are the two that mention the number and must not match.
 */
const HISTORY = [
  "Nap compaction history for session 2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77",
  "",
  'Every entry starts at the beginning of a line with its event number, as in "#46 user".',
  "",
  "==== Part 1: events #1 to #46 ====",
  "",
  "#45 assistant",
  "    The constraint is in #46, below.",
  "#46 user",
  "    #46 user",
  "    Keep the purple theme.",
  "#47 turn completed",
  "",
].join("\n");
const HISTORY_FILE = `${PROJECT_ROOT}/history.txt`;

/** Takes ripgrep away from the shell, the way a template without it looks. */
const WITHOUT_RG = `command() { if [ "$1" = -v ] && [ "$2" = rg ]; then return 1; fi; builtin command "$@"; }`;

const sandboxes: LocalShellSandbox[] = [];

afterEach(async () => {
  for (const sandbox of sandboxes.splice(0)) await sandbox.dispose();
});

describe("searching the compaction history", () => {
  it.each([
    ["ripgrep where the host has it", ""],
    ["grep alone", WITHOUT_RG],
  ])("finds exactly the one entry with %s, at a line read_file can open", async (_, prelude) => {
    const sandbox = await LocalShellSandbox.create({ prelude });
    sandboxes.push(sandbox);
    await sandbox.writeFile(sandbox.id, HISTORY_FILE, HISTORY);
    const ctx: ToolContext = {
      sessionId: "2a3f8a24-6c1b-4e0e-9b6f-3a5c0a1d9e77",
      turnId: "7c9b1a52-8d3e-4f21-a0c4-1b2d3e4f5a6b",
      sandboxId: sandbox.id,
      sandbox,
      emit: () => {},
    };

    const found = await executeTool(
      { id: "s", name: "search_files", input: { pattern: "^#46 ", path: HISTORY_FILE } },
      ctx,
    );
    expect(found.ok).toBe(true);
    const matches = found.output.trim().split("\n");
    expect(matches).toHaveLength(1);
    // BSD grep -r names the file even when it was given only one, and ripgrep does not. A model
    // reads either, so the number is what has to be right.
    const line = Number(/^(?:.+:)?(\d+):#46 user$/.exec(matches[0] ?? "")?.[1]);
    expect(line).toBe(HISTORY.split("\n").indexOf("#46 user") + 1);

    const read = await executeTool(
      { id: "r", name: "read_file", input: { path: HISTORY_FILE, offset: line, limit: 3 } },
      ctx,
    );
    expect(read.output).toContain("\t#46 user");
    expect(read.output).toContain("Keep the purple theme.");
  });
});
