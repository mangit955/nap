import { describe, expect, it } from "vitest";
import { ManualScheduler } from "../testing/manual-scheduler.ts";
import {
  CommandOutputStream,
  OUTPUT_FLUSH_AFTER_CHARS,
  OUTPUT_FLUSH_AFTER_MS,
} from "./output-stream.ts";

type Emitted = { stream: "stdout" | "stderr"; chunk: string };

/** A stream on timers a test moves by hand, so the time threshold costs no wall time. */
function collect(): { output: CommandOutputStream; emitted: Emitted[]; timers: ManualScheduler } {
  const emitted: Emitted[] = [];
  const timers = new ManualScheduler();
  return {
    output: new CommandOutputStream(
      (stream, chunk) => emitted.push({ stream, chunk }),
      timers.schedule,
    ),
    emitted,
    timers,
  };
}

const joined = (emitted: Emitted[]) => emitted.map((piece) => piece.chunk).join("");

describe("CommandOutputStream", () => {
  it("turns a thousand small chunks into a handful, losing and reordering nothing", () => {
    const { output, emitted } = collect();
    const lines = Array.from({ length: 1_000 }, (_, i) => `added package-${i}@1.0.${i}\n`);

    for (const data of lines) output.push({ stream: "stdout", data });
    output.close();

    const total = lines.join("");
    expect(joined(emitted)).toBe(total);
    expect(emitted.length).toBeLessThanOrEqual(Math.ceil(total.length / OUTPUT_FLUSH_AFTER_CHARS));
  });

  it("hands over a tail below both thresholds when closed", () => {
    const { output, emitted } = collect();

    output.push({ stream: "stdout", data: "done\n" });
    expect(emitted).toEqual([]);
    output.close();

    expect(emitted).toEqual([{ stream: "stdout", chunk: "done\n" }]);
  });

  it("shows a quiet command's output once the window closes, with nothing else arriving", () => {
    // A dev server prints its banner and then nothing for minutes. Waiting for more would
    // leave the one line that matters sitting in a buffer.
    const { output, emitted, timers } = collect();

    output.push({ stream: "stdout", data: "ready on :5173\n" });
    timers.advance(OUTPUT_FLUSH_AFTER_MS - 1);
    expect(emitted).toEqual([]);
    timers.advance(1);

    expect(emitted).toEqual([{ stream: "stdout", chunk: "ready on :5173\n" }]);
    expect(timers.pending).toBe(0);
  });

  it("keeps stdout and stderr in the order they arrived, across every switch", () => {
    const { output, emitted } = collect();

    output.push({ stream: "stdout", data: "a" });
    output.push({ stream: "stdout", data: "b" });
    output.push({ stream: "stderr", data: "c" });
    output.push({ stream: "stderr", data: "d" });
    output.push({ stream: "stdout", data: "e" });
    output.close();

    expect(emitted).toEqual([
      { stream: "stdout", chunk: "ab" },
      { stream: "stderr", chunk: "cd" },
      { stream: "stdout", chunk: "e" },
    ]);
  });

  it("never puts more than one threshold of buffered text in front of a chunk", () => {
    const { output, emitted } = collect();
    const big = "x".repeat(OUTPUT_FLUSH_AFTER_CHARS * 3);

    output.push({ stream: "stdout", data: "head\n" });
    output.push({ stream: "stdout", data: big });
    output.push({ stream: "stdout", data: "tail\n" });
    output.close();

    expect(joined(emitted)).toBe(`head\n${big}tail\n`);
    // A chunk is never split — splitting could cut a character in half — so the bound is the
    // threshold plus the largest chunk, which is what one chunk per event already allowed.
    for (const piece of emitted)
      expect(piece.chunk.length).toBeLessThan(OUTPUT_FLUSH_AFTER_CHARS + big.length);
  });

  it("is inert once closed: no timer left armed, and a late chunk is dropped", () => {
    const { output, emitted, timers } = collect();

    output.push({ stream: "stdout", data: "before\n" });
    output.close();
    output.push({ stream: "stderr", data: "after the tool returned\n" });
    timers.advance(OUTPUT_FLUSH_AFTER_MS * 10);

    expect(emitted).toEqual([{ stream: "stdout", chunk: "before\n" }]);
    expect(timers.pending).toBe(0);
  });
});
