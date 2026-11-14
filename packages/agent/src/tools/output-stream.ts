/**
 * A running command's output, on its way from the sandbox to the event log.
 *
 * The sandbox hands over output in whatever pieces the process wrote it in — for an `npm
 * install` or a test run that is a line at a time, a thousand times. Every `command.output` is a
 * durable row: an append, a notification, and a read on every API process streaming the
 * session. So pieces are coalesced here exactly as model text is, by `DeltaStream`, on two
 * thresholds: a few kilobytes, or a tenth of a second after the first byte entered the buffer.
 * A client still sees output within that tenth of a second; the log holds a few rows instead of
 * a thousand, and concatenating them gives back exactly the bytes that were written.
 *
 * **One buffer, not one per stream.** A switch from stdout to stderr hands the buffer over
 * before the other stream's text enters it, so the log keeps the order the pieces arrived in
 * across both streams — a warning stays between the lines it was printed between. A command that
 * alternates every line coalesces nothing, and is no worse than before.
 *
 * **A chunk is never split.** Splitting could cut a character in two, and no event was bounded
 * by anything but the chunk before this; an event is now at most the threshold plus one chunk.
 *
 * `close` is called the moment the sandbox call returns, however it returned, so everything is
 * in the log before the call's `tool.result` — a cancelled command included, since what it
 * printed before the cancel happened. After it the stream is inert: no timer armed, and a chunk
 * from a transport still tearing itself down is dropped rather than written after the result.
 */

import { DeltaStream, realTimers, type Schedule } from "../delta-stream.ts";

/** A few kilobytes: a screenful of build output, and far below anything a row should hold. */
export const OUTPUT_FLUSH_AFTER_CHARS = 4_096;

/** Short enough that a watcher sees a line as it is printed; long enough to gather a burst. */
export const OUTPUT_FLUSH_AFTER_MS = 100;

type OutputStream = "stdout" | "stderr";

export class CommandOutputStream {
  readonly #emit: (stream: OutputStream, chunk: string) => void;
  readonly #schedule: Schedule;
  /** The stream the buffered text belongs to. Replaced, after a flush, when the other speaks. */
  #current: { stream: OutputStream; text: DeltaStream } | undefined;
  #ended = false;

  constructor(
    emit: (stream: OutputStream, chunk: string) => void,
    schedule: Schedule = realTimers,
  ) {
    this.#emit = emit;
    this.#schedule = schedule;
  }

  push(chunk: { stream: OutputStream; data: string }): void {
    if (this.#ended) return;
    if (this.#current?.stream !== chunk.stream) {
      this.#current?.text.close();
      const stream = chunk.stream;
      this.#current = {
        stream,
        text: new DeltaStream((text) => this.#emit(stream, text), this.#schedule, {
          chars: OUTPUT_FLUSH_AFTER_CHARS,
          ms: OUTPUT_FLUSH_AFTER_MS,
        }),
      };
    }
    this.#current.text.push(chunk.data);
  }

  /** The command is over: hands over the tail and ignores anything after. */
  close(): void {
    this.#current?.text.close();
    this.#current = undefined;
    this.#ended = true;
  }
}
