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

  it("starts the next window at the flush, not at the turn", () => {
    const clock = fakeClock();
    const { stream, emitted } = collect(clock.now);

    clock.advance(FLUSH_AFTER_MS);
    stream.push("first");
    stream.push(" second");

    // The window is measured from the last flush. Measuring it from construction would
    // make every delta after the first one its own event.
    expect(emitted).toEqual(["first"]);
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

  it("restarts the window on a flush that emitted nothing", () => {
    // The loop flushes after every model call, and a step that thought nothing still took
    // seconds. Leaving the window where it was makes the *next* step's very first delta
    // overdue the moment it arrives, so each burst opens with a one-character event.
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
