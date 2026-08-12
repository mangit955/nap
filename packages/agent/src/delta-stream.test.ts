import { describe, expect, it } from "vitest";
import { DeltaStream, FLUSH_AFTER_CHARS, FLUSH_AFTER_MS } from "./delta-stream.ts";

/** A clock a test moves by hand, so the time threshold costs no wall time. */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let time = 0;
  return {
    now: () => time,
    advance: (ms) => {
      time += ms;
    },
  };
}

function collect(now: () => number = () => 0): {
  stream: DeltaStream;
  emitted: string[];
} {
  const emitted: string[] = [];
  return { stream: new DeltaStream((text) => emitted.push(text), now), emitted };
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

  it("emits a short buffer once the time threshold passes", () => {
    const clock = fakeClock();
    const { stream, emitted } = collect(clock.now);

    stream.push("first");
    clock.advance(FLUSH_AFTER_MS);
    stream.push(" second");

    expect(emitted).toEqual(["first second"]);
  });

  it("does not punish the first delta for the wait before it", () => {
    // Observed on a real turn: the model takes seconds to produce its first token, so a
    // window opened when the stream was built is already expired when that token lands and
    // the delta is emitted alone. Every message began "I" / "\'ll look at the app" and
    // "There" / "\'s now a button". The window belongs to the buffered text, so it starts
    // when text first enters the buffer.
    const clock = fakeClock();
    const { stream, emitted } = collect(clock.now);

    clock.advance(FLUSH_AFTER_MS * 20);
    stream.push("I");
    stream.push("'ll look at the app.");

    expect(emitted).toEqual([]);
  });

  it("measures the window from the oldest buffered text", () => {
    const clock = fakeClock();
    const { stream, emitted } = collect(clock.now);

    stream.push("first");
    clock.advance(FLUSH_AFTER_MS);
    stream.push(" second");

    // The point of the time threshold is that nothing sits unseen for long, so it is the
    // wait of the text already buffered that decides — not the age of the stream.
    expect(emitted).toEqual(["first second"]);
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
    const clock = fakeClock();
    const { stream, emitted } = collect(clock.now);

    clock.advance(FLUSH_AFTER_MS * 8);
    stream.flush();
    stream.push("f");
    stream.push("irst thought");

    expect(emitted).toEqual([]);
  });

  it("never emits the same text twice", () => {
    const clock = fakeClock();
    const { stream, emitted } = collect(clock.now);

    stream.push("a".repeat(FLUSH_AFTER_CHARS));
    clock.advance(FLUSH_AFTER_MS);
    stream.push("tail");
    stream.flush();

    expect(emitted.join("")).toBe(`${"a".repeat(FLUSH_AFTER_CHARS)}tail`);
  });

  it("ignores an empty delta", () => {
    const clock = fakeClock();
    const { stream, emitted } = collect(clock.now);

    clock.advance(FLUSH_AFTER_MS);
    stream.push("");

    expect(emitted).toEqual([]);
  });
});
