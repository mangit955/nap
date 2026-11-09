import { describe, expect, it } from "vitest";
import { DeltaStream, FLUSH_AFTER_CHARS, FLUSH_AFTER_MS } from "./delta-stream.ts";
import { ManualScheduler } from "./testing/manual-scheduler.ts";

/** A stream on timers a test moves by hand, so the time threshold costs no wall time. */
function collect(): {
  stream: DeltaStream;
  emitted: string[];
  timers: ManualScheduler;
} {
  const emitted: string[] = [];
  const timers = new ManualScheduler();
  return {
    stream: new DeltaStream((text) => emitted.push(text), timers.schedule),
    emitted,
    timers,
  };
}

describe("DeltaStream", () => {
  it("holds a delta shorter than both thresholds", () => {
    const { stream, emitted } = collect();

    stream.push("thinking");

    expect(emitted).toEqual([]);
  });

  it("emits once the buffer passes the character threshold", () => {
    const { stream, emitted } = collect();

    stream.push("a".repeat(FLUSH_AFTER_CHARS));

    expect(emitted).toEqual(["a".repeat(FLUSH_AFTER_CHARS)]);
  });

  it("emits everything buffered, not just the delta that crossed the line", () => {
    const { stream, emitted } = collect();

    stream.push("head ");
    stream.push("a".repeat(FLUSH_AFTER_CHARS));

    expect(emitted).toEqual([`head ${"a".repeat(FLUSH_AFTER_CHARS)}`]);
  });

  it("shows a short buffer once the window closes, though nothing else ever arrives", () => {
    // The stall this exists for: a preamble below the character threshold, and then the model
    // streams a tool call's arguments — which are not text, so nothing pushes again until the
    // whole response is over. The window has to close on its own.
    const { stream, emitted, timers } = collect();

    stream.push("Let me build the board.");
    timers.advance(FLUSH_AFTER_MS - 1);
    expect(emitted).toEqual([]);
    timers.advance(1);

    expect(emitted).toEqual(["Let me build the board."]);
    expect(timers.pending).toBe(0);
  });

  it("does not punish the first delta for the wait before it", () => {
    // Observed on a real turn: the model takes seconds to produce its first token, so a
    // window opened when the stream was built is already expired when that token lands and
    // the delta is emitted alone. Every message began "I" / "\'ll look at the app" and
    // "There" / "\'s now a button". The window belongs to the buffered text, so it starts
    // when text first enters the buffer.
    const { stream, emitted, timers } = collect();

    timers.advance(FLUSH_AFTER_MS * 20);
    stream.push("I");
    stream.push("'ll look at the app.");

    expect(emitted).toEqual([]);
    timers.advance(FLUSH_AFTER_MS);
    expect(emitted).toEqual(["I'll look at the app."]);
  });

  it("measures the window from the oldest buffered text", () => {
    // The point of the time threshold is that nothing sits unseen for long, so it is the
    // wait of the text already buffered that decides — not the age of the newest delta.
    const { stream, emitted, timers } = collect();

    stream.push("first");
    timers.advance(FLUSH_AFTER_MS - 1);
    stream.push(" second");
    timers.advance(1);

    expect(emitted).toEqual(["first second"]);
  });

  it("opens a fresh window for the text after a flush", () => {
    const { stream, emitted, timers } = collect();

    stream.push("first");
    timers.advance(FLUSH_AFTER_MS);
    timers.advance(FLUSH_AFTER_MS * 5);
    stream.push("second");
    timers.advance(FLUSH_AFTER_MS - 1);
    expect(emitted).toEqual(["first"]);
    timers.advance(1);

    expect(emitted).toEqual(["first", "second"]);
  });

  it("emits the tail on flush", () => {
    const { stream, emitted } = collect();

    stream.push("a short tail");
    stream.flush();

    expect(emitted).toEqual(["a short tail"]);
  });

  it("emits nothing on a flush with an empty buffer", () => {
    // The turn loop flushes after every model call, including the ones that thought
    // nothing — an empty `agent.thinking` would be a blank paragraph in the transcript.
    const { stream, emitted } = collect();

    stream.flush();
    stream.push("something");
    stream.flush();
    stream.flush();

    expect(emitted).toEqual(["something"]);
  });

  it("leaves nothing behind after a flush that emitted nothing", () => {
    // The loop flushes after every model call, including steps that produced nothing. Such
    // a flush must not leave a window open, or the next step's first delta is overdue the
    // moment it arrives and the burst opens with a one-character event.
    const { stream, emitted, timers } = collect();

    timers.advance(FLUSH_AFTER_MS * 8);
    stream.flush();
    stream.push("f");
    stream.push("irst thought");

    expect(emitted).toEqual([]);
  });

  it("never emits the same text twice, whichever threshold or flush got there first", () => {
    const { stream, emitted, timers } = collect();

    stream.push("short");
    stream.push("a".repeat(FLUSH_AFTER_CHARS));
    // The window that "short" opened was closed by the character threshold. Were its timer
    // left armed it would fire here, on whatever had arrived since.
    stream.push("tail");
    stream.flush();
    timers.advance(FLUSH_AFTER_MS * 2);

    expect(emitted).toEqual([`short${"a".repeat(FLUSH_AFTER_CHARS)}`, "tail"]);
    expect(timers.pending).toBe(0);
  });

  it("disarms the window on an explicit flush", () => {
    const { stream, emitted, timers } = collect();

    stream.push("before the tool call");
    stream.flush();

    expect(emitted).toEqual(["before the tool call"]);
    expect(timers.pending).toBe(0);
  });

  it("ignores an empty delta", () => {
    const { stream, emitted, timers } = collect();

    stream.push("");
    timers.advance(FLUSH_AFTER_MS);

    expect(emitted).toEqual([]);
    expect(timers.pending).toBe(0);
  });

  describe("once the step is over", () => {
    it("hands over the tail on close and leaves no timer armed", () => {
      const { stream, emitted, timers } = collect();

      stream.push("the last words");
      stream.close();

      expect(emitted).toEqual(["the last words"]);
      expect(timers.pending).toBe(0);
    });

    it("says nothing after it is closed, however late a delta arrives", () => {
      // A provider's stream can outlive the call it belonged to — a transport tearing down
      // after a cancellation delivers what it already had. None of that may reach the log.
      const { stream, emitted, timers } = collect();

      stream.close();
      stream.push("late");
      expect(timers.pending).toBe(0);
      stream.push("b".repeat(FLUSH_AFTER_CHARS));
      timers.advance(FLUSH_AFTER_MS * 2);
      stream.flush();

      expect(emitted).toEqual([]);
    });

    it("drops what is buffered when abandoned, and never fires afterwards", () => {
      const { stream, emitted, timers } = collect();

      stream.push("half a thought");
      stream.abandon();
      // Before time moves: a timer that ran would no longer be counted, armed or not.
      expect(timers.pending).toBe(0);
      timers.advance(FLUSH_AFTER_MS * 2);
      stream.push("more");
      stream.flush();
      stream.close();

      expect(emitted).toEqual([]);
      expect(timers.pending).toBe(0);
    });

    it("closes once: a second close emits nothing", () => {
      const { stream, emitted } = collect();

      stream.push("once");
      stream.close();
      stream.close();

      expect(emitted).toEqual(["once"]);
    });
  });
});
