import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { groupSteps, type StepGroup } from "./step-group.ts";
import { StepGroupCard } from "./step-group-card.tsx";
import type { TranscriptItem } from "./transcript.ts";

/**
 * The card a run of tool calls collapses into.
 *
 * Queried through the `group` role the `<details>` exposes, never through `button`: `<summary>`
 * maps to no role in this ARIA implementation, so a `getByRole("button")` inside a disclosure
 * finds nothing and the assertion passes against markup that cannot hold it.
 */

let nextKey = 1;

function step(overrides: Partial<Extract<TranscriptItem, { kind: "step" }>> = {}) {
  return {
    kind: "step",
    key: nextKey++,
    toolCallId: `c${nextKey}`,
    toolName: "read_file",
    input: { path: "src/App.tsx" },
    status: "ok",
    output: "",
    streamed: "",
    hasStderr: false,
    files: [],
    ...overrides,
  } as Extract<TranscriptItem, { kind: "step" }>;
}

function show(...steps: Extract<TranscriptItem, { kind: "step" }>[]) {
  nextKey = 1;
  const [group] = groupSteps(steps);
  return render(<StepGroupCard group={group as StepGroup} />);
}

/**
 * The card itself.
 *
 * Every step inside it is a `<details>` too, so there are several `group`s on the page and
 * `getByRole("group")` throws. The outermost is first in document order, which is the one thing
 * about the nesting that cannot change without the card ceasing to be a card.
 */
function card(): HTMLElement {
  const [outermost] = screen.getAllByRole("group");
  if (outermost === undefined) throw new Error("no card rendered");
  return outermost;
}

describe("what the card says when it is shut", () => {
  it("counts the actions rather than listing them", () => {
    // The whole reason the card exists: twenty mono lines is a wall, and the number is what
    // tells somebody whether the last minute was one file or the whole project.
    show(step(), step(), step());

    expect(card()).toHaveTextContent(/3 actions/);
  });

  it("says one action in the singular", () => {
    show(step());

    // Stated as two assertions rather than one anchored regex: the summary runs straight into
    // the row beneath it in `textContent`, so there is no word boundary after "action" to
    // anchor against and `/\b1 action\b/` fails on markup that is perfectly correct.
    expect(card()).toHaveTextContent("1 action");
    expect(card()).not.toHaveTextContent("1 actions");
  });

  it("says how many failed", () => {
    nextKey = 1;
    show(step({ status: "failed" }), step());

    expect(card()).toHaveTextContent(/1 failed/);
  });

  it("names what it is doing while it is still doing it", () => {
    // A count that climbs from 1 to 8 says the agent is busy and nothing else. What it is
    // reading right now is the fact worth showing.
    nextKey = 1;
    show(step(), step({ status: "running", input: { path: "src/main.tsx" } }));

    expect(card()).toHaveTextContent(/Reading/);
    expect(card()).toHaveTextContent(/src\/main\.tsx/);
  });
});

describe("what it opens itself for", () => {
  it("opens when a step failed", () => {
    // Everything else is one click away, but a failure the reader has to go looking for is a
    // failure they will miss.
    nextKey = 1;
    show(step({ status: "failed" }));

    expect(card()).toHaveAttribute("open");
  });

  it("stays shut when everything worked", () => {
    show(step(), step());

    expect(card()).not.toHaveAttribute("open");
  });

  it("stays shut while it is merely running", () => {
    // Work in progress is not a problem, and a card that sprang open on every tool call would
    // shove the conversation off the screen for the length of a turn.
    nextKey = 1;
    show(step({ status: "running" }));

    expect(card()).not.toHaveAttribute("open");
  });
});

describe("who can tell what state it is in", () => {
  it("says failed in words, not only in colour", () => {
    nextKey = 1;
    show(step({ status: "failed" }));

    expect(card()).toHaveTextContent(/failed/i);
  });

  it("says it is working in words", () => {
    nextKey = 1;
    show(step({ status: "running" }));

    expect(card()).toHaveTextContent(/working/i);
  });
});

describe("what is inside it", () => {
  it("keeps every step reachable", () => {
    nextKey = 1;
    show(
      step({ input: { path: "src/App.tsx" } }),
      step({ toolName: "run_command", input: { command: "bun run build" } }),
    );

    expect(card()).toHaveTextContent(/src\/App\.tsx/);
    expect(card()).toHaveTextContent(/bun run build/);
  });

  it("keeps a step's own output reachable", () => {
    nextKey = 1;
    show(step({ status: "failed", output: "ENOENT: no such file" }));

    expect(card()).toHaveTextContent(/ENOENT: no such file/);
  });
});
