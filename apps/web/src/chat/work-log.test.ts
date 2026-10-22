import { describe, expect, it } from "vitest";
import type { TranscriptItem } from "./transcript.ts";
import {
  commandExitCode,
  commandProgramName,
  entryFailed,
  formatDuration,
  latestThought,
  liveThoughtLine,
  liveWorkEntryLabel,
  summarizeToolGroup,
  toolGroupSummaryKind,
  type WorkEntry,
  workEntryDisplayLabel,
} from "./work-log.ts";

/**
 * The work log's vocabulary: what a run of tool calls is called once it has finished, what the
 * one still going is called while it runs, and how long a turn took.
 *
 * A `.test.ts` because none of it needs a DOM. The wording is the product here — it is the
 * whole face of a collapsed group — so the sentences are asserted exactly.
 */

type Step = Extract<TranscriptItem, { kind: "step" }>;

let nextKey = 1;

function step(overrides: Partial<Step> = {}): Step {
  const key = nextKey++;
  return {
    kind: "step",
    key,
    at: "2026-08-09T12:00:00.000Z",
    toolCallId: `c${key}`,
    toolName: "read_file",
    input: { path: "/home/user/app/src/App.tsx" },
    status: "ok",
    output: "",
    streamed: "",
    files: [],
    ...overrides,
  };
}

const read = (path = "src/App.tsx") => step({ toolName: "read_file", input: { path } });
const run = (command: string, overrides: Partial<Step> = {}) =>
  step({ toolName: "run_command", input: { command }, output: "exit code 0\n", ...overrides });
const edit = (path: string) =>
  step({
    toolName: "edit_file",
    input: { path },
    files: [{ path, changeType: "modified", diff: "", added: 1, removed: 0 }],
  });
const search = () => step({ toolName: "search_files", input: { pattern: "useState" } });
const thought = (text: string): WorkEntry => ({ kind: "thinking", key: nextKey++, text });

describe("summarizeToolGroup", () => {
  it("names each kind of work with its count", () => {
    expect(summarizeToolGroup([read(), read("b.ts"), read("c.ts")]).summary).toBe("Read 3 files");
    expect(summarizeToolGroup([run("bun test")]).summary).toBe("Ran 1 command");
  });

  it("joins two kinds into one sentence", () => {
    expect(summarizeToolGroup([read(), run("bun run build"), run("bun test")]).summary).toBe(
      "Read 1 file and ran 2 commands",
    );
  });

  it("keeps the two most important kinds and counts the rest", () => {
    // Commands and edits outrank reads and searches, so a group that read, searched and ran
    // names the reads (first in order among the equals) and the commands, and the search
    // becomes "other". The order on screen is the order the work happened in.
    const summary = summarizeToolGroup([
      read(),
      read("b.ts"),
      read("c.ts"),
      search(),
      run("bun run build"),
      run("bun test"),
    ]).summary;

    expect(summary).toBe("Read 3 files, ran 2 commands, and performed 1 other action");
  });

  it("puts a change ahead of a read when it has to choose", () => {
    const summary = summarizeToolGroup([read(), search(), edit("src/App.tsx")]).summary;

    expect(summary).toBe("Read 1 file, changed 1 file, and performed 1 other action");
  });

  it("counts changed files rather than edits", () => {
    // Three edits to one file changed one file; the sentence is about the project, not the
    // number of calls it took.
    const summary = summarizeToolGroup([edit("a.ts"), edit("a.ts"), edit("b.ts")]).summary;

    expect(summary).toBe("Changed 2 files");
  });

  it("does not count reasoning as work", () => {
    expect(summarizeToolGroup([thought("hmm"), read(), thought("ok")]).summary).toBe("Read 1 file");
  });

  it("calls a group of nothing but reasoning a thought", () => {
    expect(summarizeToolGroup([thought("hmm")]).summary).toBe("Thought");
  });

  it("says when something in the group failed", () => {
    expect(summarizeToolGroup([read(), read("b.ts")]).hasFailure).toBe(false);
    expect(
      summarizeToolGroup([read(), run("bun run build", { status: "failed" })]).hasFailure,
    ).toBe(true);
  });

  it("counts a command that exited non-zero as a failure", () => {
    // `run_command` reports a failing build as a successful tool call, because the model has to
    // read it — but to the person watching, the build failed.
    const failing = run("bun run build", { output: "exit code 2\ntype error\n" });

    expect(summarizeToolGroup([failing]).hasFailure).toBe(true);
  });
});

describe("toolGroupSummaryKind", () => {
  it("names a group that did one kind of thing after it", () => {
    expect(toolGroupSummaryKind([read(), read()])).toBe("read");
    expect(toolGroupSummaryKind([run("ls")])).toBe("command");
    expect(toolGroupSummaryKind([search()])).toBe("code-search");
    expect(toolGroupSummaryKind([edit("a.ts")])).toBe("edit");
  });

  it("calls anything else mixed, and reasoning reasoning", () => {
    expect(toolGroupSummaryKind([read(), run("ls")])).toBe("mixed");
    expect(toolGroupSummaryKind([thought("hmm")])).toBe("reasoning");
    expect(toolGroupSummaryKind([thought("hmm"), read()])).toBe("read");
  });
});

describe("liveWorkEntryLabel", () => {
  it("names a running command by its program alone", () => {
    expect(liveWorkEntryLabel(run("bun run build", { status: "running" }), true)).toBe(
      "Running bun",
    );
  });

  it("says it ran once it has", () => {
    expect(liveWorkEntryLabel(run("bun run build"), true)).toBe("Ran bun");
  });

  it("says it failed when it did, by either measure", () => {
    expect(liveWorkEntryLabel(run("bun run build", { status: "failed" }), true)).toBe("Failed bun");
    expect(liveWorkEntryLabel(run("bun run build", { output: "exit code 1\n" }), true)).toBe(
      "Failed bun",
    );
  });

  it("does not call a call running once the turn is no longer live", () => {
    expect(liveWorkEntryLabel(run("bun test", { status: "running" }), false)).toBe("Ran bun");
  });

  it("falls back to the work itself for everything that is not a command", () => {
    expect(liveWorkEntryLabel(read(), true)).toBe("Read src/App.tsx");
  });

  it("calls a command it cannot name a command", () => {
    expect(liveWorkEntryLabel(run("cd /tmp", { status: "running" }), true)).toBe("Running command");
  });
});

describe("workEntryDisplayLabel", () => {
  it("shows a command as itself, and a read as what it read", () => {
    expect(workEntryDisplayLabel(run("bun run build"))).toBe("bun run build");
    expect(workEntryDisplayLabel(read("/home/user/app/src/main.tsx"))).toBe("Read src/main.tsx");
  });

  it("shows a change as the file it changed", () => {
    expect(workEntryDisplayLabel(edit("/home/user/app/src/App.tsx"))).toBe("src/App.tsx");
  });

  it("says what a search looked for and where", () => {
    expect(
      workEntryDisplayLabel(
        step({ toolName: "search_files", input: { pattern: "useState", path: "src" } }),
      ),
    ).toBe("Searched useState in src");
    expect(workEntryDisplayLabel(step({ toolName: "list_files", input: { path: "src" } }))).toBe(
      "Listed src",
    );
  });

  it("gives a tool whose arguments never arrived an honest name", () => {
    // A client that connected between a call and its result holds the result alone, and
    // inventing a target for it would be a lie.
    expect(workEntryDisplayLabel(step({ toolName: "run_command", input: {} }))).toBe("Ran command");
    expect(workEntryDisplayLabel(step({ toolName: "read_file", input: {} }))).toBe("Read file");
  });

  it("shows a thought as its own words, on one line", () => {
    expect(workEntryDisplayLabel(thought("**Planning**\n\nI should read\nthe file."))).toBe(
      "Planning I should read the file.",
    );
  });
});

describe("commandProgramName", () => {
  it.each([
    ["bun run build", "bun"],
    ["/home/user/.bun/bin/bun test", "bun"],
    ["CI=1 NODE_ENV=test npx vitest run", "npx"],
    ["cd packages/app && bun install", "bun"],
    ["sudo -u root pnpm test", "pnpm"],
    ["timeout 10s python3 script.py", "python3"],
    ["bash -lc 'git status'", "git"],
    ["# a comment\ngit status", "git"],
  ])("%s → %s", (command, program) => {
    expect(commandProgramName(command)).toBe(program);
  });

  it.each(["cd /tmp", "export A=1", "", "  "])("finds no program in %j", (command) => {
    expect(commandProgramName(command)).toBeNull();
  });
});

describe("commandExitCode and entryFailed", () => {
  it("reads the code run_command reports on its first line", () => {
    expect(commandExitCode(run("ls", { output: "exit code 0\nsrc\n" }))).toBe(0);
    expect(commandExitCode(run("ls", { output: "exit code 127\nnot found\n" }))).toBe(127);
    expect(commandExitCode(run("ls", { output: "" }))).toBeUndefined();
  });

  it("only reads it from a command", () => {
    expect(commandExitCode(read())).toBeUndefined();
  });

  it("treats a refused call and a non-zero exit as failures, and nothing else", () => {
    expect(entryFailed(run("ls"))).toBe(false);
    expect(entryFailed(run("ls", { output: "exit code 1\n" }))).toBe(true);
    expect(entryFailed(read())).toBe(false);
    expect(entryFailed(step({ status: "failed" }))).toBe(true);
    expect(entryFailed(thought("hmm"))).toBe(false);
  });
});

describe("liveThoughtLine and latestThought", () => {
  it("keeps a bold heading when the thought has one", () => {
    expect(liveThoughtLine("**Planning the layout**\nI need a grid.")).toBe("Planning the layout");
  });

  it("otherwise keeps the first sentence, without the markdown", () => {
    expect(liveThoughtLine("I should read `App.tsx` first. Then edit it.")).toBe(
      "I should read App.tsx first.",
    );
  });

  it("keeps a sentence still being written whole", () => {
    expect(liveThoughtLine("I should read the")).toBe("I should read the");
  });

  it("previews the newest section of a passage, so a long thought stays live", () => {
    // The cheap model streams its reasoning, and the transcript joins a run of it into one
    // passage. Previewing the passage's first sentence would freeze the preview on the oldest
    // thing it thought; the newest section is what it is thinking now.
    const text =
      "**Reading the project**\n\nIt is a Vite app.\n\n**Planning the header**\n\nIt needs a logo.";

    expect(latestThought(text)).toBe("Planning the header");
    expect(latestThought("First idea.\n\nSecond idea is forming")).toBe("Second idea is forming");
  });

  it("previews nothing for a passage of whitespace", () => {
    expect(latestThought("  \n\n ")).toBe("");
  });
});

describe("formatDuration", () => {
  it.each([
    [250, "250ms"],
    [4_260, "4.3s"],
    [12_400, "12s"],
    [59_600, "1m"],
    [72_000, "1m 12s"],
    [3_723_000, "1h 2m 3s"],
  ])("%d ms → %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });
});
