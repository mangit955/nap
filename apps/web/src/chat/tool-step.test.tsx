import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ToolStep } from "./tool-step.tsx";
import type { FileChange, TranscriptItem } from "./transcript.ts";

type Step = Extract<TranscriptItem, { kind: "step" }>;

function step(overrides: Partial<Step> = {}): Step {
  return {
    kind: "step",
    key: 1,
    toolCallId: "c1",
    toolName: "run_command",
    input: { command: "bun run build" },
    status: "running",
    output: "",
    streamed: "",
    hasStderr: false,
    files: [],
    ...overrides,
  };
}

const fileChange = (overrides: Partial<FileChange> = {}): FileChange => ({
  path: "src/App.tsx",
  changeType: "modified",
  diff: "@@ -1 +1 @@\n-old\n+new\n",
  added: 1,
  removed: 1,
  ...overrides,
});

describe("what the step says it is doing", () => {
  it("names the command a run_command step is running", () => {
    render(<ToolStep step={step()} />);

    expect(screen.getByRole("group")).toHaveTextContent("bun run build");
  });

  it("names the file a file tool is working on", () => {
    render(
      <ToolStep
        step={step({ toolName: "read_file", input: { path: "/home/user/app/src/App.tsx" } })}
      />,
    );

    expect(screen.getByRole("group")).toHaveTextContent("src/App.tsx");
  });

  it("names the pattern a search is looking for", () => {
    render(<ToolStep step={step({ toolName: "search_files", input: { pattern: "useState" } })} />);

    expect(screen.getByRole("group")).toHaveTextContent("useState");
  });

  it("still says something for a tool whose arguments never arrived", () => {
    // The reconnect case: a result without its call. A blank line would read as a bug.
    render(<ToolStep step={step({ input: {} })} />);

    // `<summary>` maps to no role of its own here, so the disclosure is queried as the
    // `group` its `<details>` exposes.
    expect(screen.getByRole("group")).toHaveTextContent(/run/i);
  });
});

describe("status", () => {
  it("says a step without a result is still running", () => {
    // In words, not in colour: this is the difference between "it is working" and "it hung".
    render(<ToolStep step={step({ status: "running" })} />);

    expect(screen.getByRole("group")).toHaveTextContent(/running/i);
  });

  it("says a failed step failed", () => {
    render(<ToolStep step={step({ status: "failed", output: "exit code 1" })} />);

    expect(screen.getByRole("group")).toHaveTextContent(/failed/i);
  });

  it("does not describe a finished step as running", () => {
    render(<ToolStep step={step({ status: "ok", output: "done" })} />);

    expect(screen.getByRole("group")).not.toHaveTextContent(/running/i);
  });

  it("opens a failed step so the reason is on screen without a click", () => {
    render(<ToolStep step={step({ status: "failed", output: "exit code 1" })} />);

    expect(screen.getByRole("group")).toHaveAttribute("open");
    expect(screen.getByText("exit code 1")).toBeVisible();
  });

  it("leaves a successful step collapsed", () => {
    render(<ToolStep step={step({ status: "ok", output: "contents" })} />);

    expect(screen.getByRole("group")).not.toHaveAttribute("open");
  });
});

describe("output", () => {
  it("shows what the command printed", () => {
    render(<ToolStep step={step({ status: "ok", streamed: "vite v8.0.0\ndone\n" })} />);

    expect(screen.getByText("vite v8.0.0")).toBeInTheDocument();
  });

  it("shows the result the model was given when nothing was streamed", () => {
    render(<ToolStep step={step({ toolName: "read_file", status: "ok", output: "file body" })} />);

    expect(screen.getByText("file body")).toBeInTheDocument();
  });

  it("does not repeat streamed output that the result also contains", () => {
    // `run_command` reports its own stdout back to the model, so rendering both prints the
    // whole build log twice.
    render(
      <ToolStep
        step={step({ status: "ok", streamed: "building…\n", output: "exit code 0\nbuilding…\n" })}
      />,
    );

    expect(screen.getAllByText("building…")).toHaveLength(1);
  });
});

describe("file changes", () => {
  it("lists what the step touched, with its line counts", () => {
    render(
      <ToolStep
        step={step({
          toolName: "write_file",
          status: "ok",
          files: [fileChange({ added: 42, removed: 11 })],
        })}
      />,
    );

    const group = screen.getByRole("group");
    expect(group).toHaveTextContent("src/App.tsx");
    expect(group).toHaveTextContent("+42");
    expect(group).toHaveTextContent("−11");
  });

  it("says what happened to the file, not only that something did", () => {
    render(
      <ToolStep
        step={step({
          toolName: "write_file",
          status: "ok",
          files: [fileChange({ changeType: "created" })],
        })}
      />,
    );

    expect(screen.getByRole("group")).toHaveTextContent(/created/i);
  });

  it("shows no chip when the step changed nothing", () => {
    render(<ToolStep step={step({ toolName: "read_file", status: "ok" })} />);

    expect(screen.queryByText(/src\/App\.tsx/)).not.toBeInTheDocument();
  });
});

describe("diffs", () => {
  it("shows the diff of a file the step wrote", () => {
    // Inside the step's own disclosure: by the time someone has opened a write step, the diff
    // is what they came for, and a second click to reach it is one too many.
    render(
      <ToolStep
        step={step({
          toolName: "write_file",
          status: "ok",
          files: [fileChange({ diff: "@@ -1 +1 @@\n-was here\n+is here\n" })],
        })}
      />,
    );

    expect(screen.getByText("+is here")).toBeInTheDocument();
    expect(screen.getByText("-was here")).toBeInTheDocument();
  });
});
