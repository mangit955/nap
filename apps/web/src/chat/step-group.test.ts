import { describe, expect, it } from "vitest";
import { groupSteps } from "./step-group.ts";
import type { FileChange, TranscriptItem } from "./transcript.ts";

/**
 * Folding a run of tool calls into one card.
 *
 * A turn is mostly tool calls and almost none of them are worth reading individually, so the
 * transcript shows a run of them as a single "8 actions" disclosure. This is the second of two
 * folds — `buildTranscript` turns events into items, and this turns items into what is drawn —
 * and keeping it separate is what lets the interesting cases be checked without rendering.
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

function message(text: string): TranscriptItem {
  return { kind: "message", key: nextKey++, from: "agent", text };
}

function change(path: string): FileChange {
  return { path, changeType: "created", diff: "+one\n", added: 1, removed: 0 };
}

describe("folding a run of steps", () => {
  it("makes one group of several adjacent steps", () => {
    nextKey = 1;
    const items = groupSteps([step(), step(), step()]);

    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("steps");
  });

  it("keeps every step in the group", () => {
    nextKey = 1;
    const [group] = groupSteps([step(), step(), step()]);

    expect(group?.kind === "steps" && group.steps).toHaveLength(3);
  });

  it("leaves a single step as a group of one", () => {
    // Rather than passing it through as a bare step: one shape on screen for "what the agent
    // did" means the card's summary and its disclosure behave the same whether a turn made one
    // tool call or twenty.
    nextKey = 1;
    const items = groupSteps([step()]);

    expect(items[0]?.kind).toBe("steps");
  });

  it("splits a run where the agent said something in the middle", () => {
    // Prose between two runs is the model explaining what it just did and what it is about to
    // do. Folding across it would file the explanation under the wrong half of the work.
    nextKey = 1;
    const items = groupSteps([step(), message("Now I will build it."), step(), step()]);

    expect(items.map((item) => item.kind)).toEqual(["steps", "message", "steps"]);
  });

  it("passes everything that is not a step through untouched", () => {
    nextKey = 1;
    const notice: TranscriptItem = { kind: "notice", key: 99, level: "info", text: "hello" };

    expect(groupSteps([notice])).toEqual([notice]);
  });

  it("keeps the order of what it did not group", () => {
    nextKey = 1;
    const items = groupSteps([message("first"), step(), message("last")]);

    expect(items.map((item) => item.kind)).toEqual(["message", "steps", "message"]);
  });
});

describe("the key the group is drawn under", () => {
  it("is the first member's, not the last", () => {
    // The same rule the thinking passage follows, and for the same reason: keyed to the newest
    // member, React would remount the card every time a tool result arrived — springing it shut
    // in the middle of a turn somebody was reading.
    nextKey = 1;
    const first = step();
    const [group] = groupSteps([first, step(), step()]);

    expect(group?.key).toBe(first.key);
  });

  it("does not move when a later step is added", () => {
    nextKey = 1;
    const one = step();
    const two = step();

    const before = groupSteps([one, two])[0]?.key;
    const after = groupSteps([one, two, step()])[0]?.key;

    expect(after).toBe(before);
  });
});

describe("what the group says it is doing", () => {
  it("is running while any step still is", () => {
    nextKey = 1;
    const [group] = groupSteps([step({ status: "ok" }), step({ status: "running" })]);

    expect(group?.kind === "steps" && group.status).toBe("running");
  });

  it("is failed when any step failed, even if a later one succeeded", () => {
    // A failure that scrolled past inside a collapsed card is a failure nobody reads. The
    // group has to advertise it on its own face.
    nextKey = 1;
    const [group] = groupSteps([step({ status: "failed" }), step({ status: "ok" })]);

    expect(group?.kind === "steps" && group.status).toBe("failed");
  });

  it("prefers failed over running", () => {
    nextKey = 1;
    const [group] = groupSteps([step({ status: "failed" }), step({ status: "running" })]);

    expect(group?.kind === "steps" && group.status).toBe("failed");
  });

  it("is done once every step has settled", () => {
    nextKey = 1;
    const [group] = groupSteps([step({ status: "ok" }), step({ status: "ok" })]);

    expect(group?.kind === "steps" && group.status).toBe("ok");
  });

  it("counts how many steps failed", () => {
    nextKey = 1;
    const [group] = groupSteps([step({ status: "failed" }), step({ status: "failed" }), step()]);

    expect(group?.kind === "steps" && group.failed).toBe(2);
  });
});

describe("a file change with no step to hang it on", () => {
  it("joins the run it is sitting in", () => {
    // `file.changed` arrives without a `toolCallId`, so a client that connected between a call
    // and its result gets one standing alone. It belongs with the work around it rather than
    // as its own block between two halves of one card.
    nextKey = 1;
    const orphan: TranscriptItem = { kind: "files", key: 50, files: [change("src/App.tsx")] };
    const items = groupSteps([step(), orphan, step()]);

    expect(items).toHaveLength(1);
    expect(items[0]?.kind === "steps" && items[0].files.map((file) => file.path)).toEqual([
      "src/App.tsx",
    ]);
  });

  it("opens a group of its own when there is no run to join", () => {
    nextKey = 1;
    const orphan: TranscriptItem = { kind: "files", key: 50, files: [change("src/App.tsx")] };
    const items = groupSteps([message("before"), orphan, message("after")]);

    expect(items.map((item) => item.kind)).toEqual(["message", "steps", "message"]);
  });
});

describe("how many actions the card reports", () => {
  it("counts the steps", () => {
    nextKey = 1;
    const [group] = groupSteps([step(), step(), step()]);

    expect(group?.kind === "steps" && group.steps.length).toBe(3);
  });

  it("does not count a standalone file change as an action", () => {
    // It is the *evidence* of an action, not one — and the tool call that produced it is
    // already counted wherever it was received.
    nextKey = 1;
    const orphan: TranscriptItem = { kind: "files", key: 50, files: [change("a.ts")] };
    const [group] = groupSteps([step(), orphan]);

    expect(group?.kind === "steps" && group.steps.length).toBe(1);
  });
});
