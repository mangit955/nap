import type { StoredEvent } from "@nap/shared/ports/event-store";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ChatTranscript } from "./chat-transcript.tsx";
import { buildTranscript } from "./transcript.ts";

/**
 * How a finished turn's work log slides open and shut: the rows of a closing log stay drawn, and
 * inert, until that fold's own transitions end. What the fold hides is `timeline.test.ts`'s.
 */

const SESSION = "0b7f8f1e-3c2a-4d5b-9e6f-1a2b3c4d5e6f";
const TURN = "7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";

let nextSeq = 1;

describe("a finished turn's log sliding open and shut", () => {
  /**
   * jsdom runs no CSS, so it has no transitions and no `getAnimations`. Each closed segment is
   * handed one transition per call here, which the test finishes when it chooses, the way a browser
   * finishes the 180 ms one.
   */
  let running: Map<string, (() => void)[]>;

  function installTransitions() {
    running = new Map();
    Object.defineProperty(Element.prototype, "getAnimations", {
      configurable: true,
      value(this: HTMLElement) {
        const fold = this.dataset.fold ?? "";
        let end = () => {};
        const promise = new Promise<void>((resolve) => {
          end = resolve;
        });
        running.set(fold, [...(running.get(fold) ?? []), end]);
        return [{ finished: promise }];
      },
    });
  }

  afterEach(() => {
    Reflect.deleteProperty(Element.prototype, "getAnimations");
  });

  /** Ends the transitions started so far for a fold, oldest first, leaving any later ones. */
  async function finishEarliest(fold: string, count: number) {
    await act(async () => {
      const started = running.get(fold) ?? [];
      for (const end of started.splice(0, count)) end();
    });
  }

  async function finishTransitions(fold: string) {
    await act(async () => {
      for (const end of running.get(fold) ?? []) end();
      running.delete(fold);
    });
  }

  /** One finished turn reading `file`; `notice` splits its hidden work into two segments. */
  function turn(text: string, turnId: string, file: string, notice = false) {
    const at = { sessionId: SESSION, turnId, createdAt: "2026-08-09T12:00:00.000Z" };
    return [
      { ...at, seq: nextSeq++, type: "user.message", payload: { text } },
      { ...at, seq: nextSeq++, type: "turn.started", payload: { source: "user" } },
      {
        ...at,
        seq: nextSeq++,
        type: "tool.call",
        payload: { toolCallId: `${turnId}-c`, toolName: "read_file", input: { path: file } },
      },
      {
        ...at,
        seq: nextSeq++,
        type: "tool.result",
        payload: { toolCallId: `${turnId}-c`, toolName: "read_file", ok: true, output: "x" },
      },
      ...(notice
        ? [
            {
              ...at,
              seq: nextSeq++,
              type: "system.notice",
              payload: { level: "info", text: "Sandbox resumed." },
            },
            {
              ...at,
              seq: nextSeq++,
              type: "tool.call",
              payload: {
                toolCallId: `${turnId}-d`,
                toolName: "read_file",
                input: { path: `${file}.map` },
              },
            },
            {
              ...at,
              seq: nextSeq++,
              type: "tool.result",
              payload: { toolCallId: `${turnId}-d`, toolName: "read_file", ok: true, output: "x" },
            },
          ]
        : []),
      { ...at, seq: nextSeq++, type: "agent.message", payload: { text: `Read ${file}.` } },
      {
        ...at,
        seq: nextSeq++,
        type: "turn.completed",
        payload: { usage: { inputTokens: 1, outputTokens: 1 }, durationMs: 4_000 },
      },
    ] as StoredEvent[];
  }

  function twoTurns({ split = false } = {}) {
    nextSeq = 1;
    const events = [
      ...turn("first", TURN, "a.ts", split),
      ...turn("second", "8d2e3f4a-5b6c-4d7e-9f80-1a2b3c4d5e61", "b.ts"),
    ];
    const view = render(<ChatTranscript items={buildTranscript(events)} />);
    const [first, second] = screen.getAllByRole("button", { name: /^Worked for/ });
    if (first === undefined || second === undefined) throw new Error("expected two folds");
    const segments = () =>
      Array.from(view.container.querySelectorAll<HTMLElement>(".chat-fold-content"));
    const segment = (path: string) =>
      segments().find((element) => element.textContent?.includes(path));
    return { first, second, segment, segments };
  }

  it("keeps a closing log's rows, inert, until its transition ends", async () => {
    installTransitions();
    const { first, segment } = twoTurns();
    fireEvent.click(first);
    expect(segment("a.ts")?.dataset.open).toBe("true");

    fireEvent.click(first);
    expect(first.getAttribute("aria-expanded")).toBe("false");
    const closing = segment("a.ts");
    expect(closing?.dataset.open).toBe("false");
    expect(closing?.hasAttribute("inert")).toBe(true);

    await finishTransitions(closing?.dataset.fold ?? "");
    expect(segment("a.ts")).toBeUndefined();
  });

  it("keeps the rows of a log reopened before its transition ended", async () => {
    installTransitions();
    const { first, segment } = twoTurns();
    fireEvent.click(first);
    fireEvent.click(first);
    const fold = segment("a.ts")?.dataset.fold ?? "";
    fireEvent.click(first);
    // A browser settles the cancelled transition's `finished`; that must not take the rows.
    await finishTransitions(fold);
    expect(segment("a.ts")?.dataset.open).toBe("true");
    expect(segment("a.ts")?.hasAttribute("inert")).toBe(false);

    fireEvent.click(first);
    await finishTransitions(fold);
    expect(segment("a.ts")).toBeUndefined();
  });

  it("lets a log closed again finish closing when the cancelled transition settles first", async () => {
    installTransitions();
    const { first, segment } = twoTurns();
    fireEvent.click(first);
    fireEvent.click(first);
    const fold = segment("a.ts")?.dataset.fold ?? "";
    const firstClose = running.get(fold)?.length ?? 0;
    fireEvent.click(first);
    fireEvent.click(first);
    await finishEarliest(fold, firstClose);
    expect(segment("a.ts")?.dataset.open).toBe("false");

    await finishTransitions(fold);
    expect(segment("a.ts")).toBeUndefined();
  });

  it("releases each closing log when its own transition ends", async () => {
    installTransitions();
    const { first, second, segment } = twoTurns();
    fireEvent.click(first);
    fireEvent.click(second);
    fireEvent.click(first);
    fireEvent.click(second);
    const firstFold = segment("a.ts")?.dataset.fold ?? "";
    const secondFold = segment("b.ts")?.dataset.fold ?? "";

    await finishTransitions(secondFold);
    expect(segment("b.ts")).toBeUndefined();
    expect(segment("a.ts")?.dataset.open).toBe("false");

    await finishTransitions(firstFold);
    expect(segment("a.ts")).toBeUndefined();
  });

  it("waits for every segment of a log split by a notice", async () => {
    installTransitions();
    const { first, segments } = twoTurns({ split: true });
    fireEvent.click(first);
    fireEvent.click(first);
    const closing = segments();
    expect(closing).toHaveLength(2);
    const fold = closing[0]?.dataset.fold ?? "";
    expect(closing.every((element) => element.dataset.fold === fold)).toBe(true);

    // The first segment's transition ends before the second's: neither may go yet.
    await finishEarliest(fold, 1);
    expect(segments()).toHaveLength(2);

    await finishTransitions(fold);
    expect(segments()).toHaveLength(0);
  });

  it("drops a closed log's rows at once when there is no transition to wait for", async () => {
    const { first, segment } = twoTurns();
    fireEvent.click(first);
    await act(async () => fireEvent.click(first));
    expect(segment("a.ts")).toBeUndefined();
  });
});
