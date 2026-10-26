import type { DesktopError } from "@nap/shared/ports/sandbox-desktop";
import type {
  RecordedVideo,
  SandboxRecording,
  SandboxRecordings,
} from "@nap/shared/ports/sandbox-recordings";
import type { Result } from "@nap/shared/result";

/** Scripted video bytes with explicit encoder time and independent sandbox ownership. */
export class FakeSandboxRecordings implements SandboxRecordings {
  readonly calls: (SandboxRecording & {
    operation: "begin" | "timestamp" | "finish" | "discard";
  })[] = [];
  readonly #video: RecordedVideo;
  readonly #captures = new Map<
    string,
    { sandboxId: string; state: "running" | "finished"; timeMs: number }
  >();
  #failure: DesktopError | undefined;
  constructor(video: RecordedVideo) {
    this.#video = structuredClone(video);
  }
  failWith(error: DesktopError | undefined): this {
    this.#failure = error;
    return this;
  }
  #key(ref: SandboxRecording): string {
    return JSON.stringify([ref.sandboxId, ref.recordingId]);
  }
  advance(ref: SandboxRecording, timeMs: number): void {
    const capture = this.#captures.get(this.#key(ref));
    if (capture?.state !== "running" || !Number.isInteger(timeMs) || timeMs < capture.timeMs)
      throw new Error("FakeSandboxRecordings: invalid encoder time.");
    capture.timeMs = timeMs;
  }
  async begin(
    options: SandboxRecording & { signal?: AbortSignal },
  ): Promise<Result<void, DesktopError>> {
    const ref = { sandboxId: options.sandboxId, recordingId: options.recordingId };
    this.calls.push({ ...ref, operation: "begin" });
    if (options.signal?.aborted)
      return { ok: false, error: { code: "cancelled", message: "Recording cancelled." } };
    if (this.#failure) return { ok: false, error: { ...this.#failure } };
    for (const [key, capture] of this.#captures) {
      if (
        capture.sandboxId === ref.sandboxId &&
        key !== this.#key(ref) &&
        capture.state === "running"
      )
        return { ok: false, error: { code: "unavailable", message: "A recording is active." } };
    }
    if (!this.#captures.has(this.#key(ref)))
      this.#captures.set(this.#key(ref), { sandboxId: ref.sandboxId, state: "running", timeMs: 0 });
    return { ok: true, value: undefined };
  }
  async timestamp(ref: SandboxRecording): Promise<Result<number, DesktopError>> {
    this.calls.push({ ...ref, operation: "timestamp" });
    if (this.#failure) return { ok: false, error: { ...this.#failure } };
    const capture = this.#captures.get(this.#key(ref));
    return capture?.state === "running"
      ? { ok: true, value: capture.timeMs }
      : { ok: false, error: { code: "not_started", message: "Recording is not running." } };
  }
  async finish(ref: SandboxRecording): Promise<Result<RecordedVideo, DesktopError>> {
    this.calls.push({ ...ref, operation: "finish" });
    if (this.#failure) return { ok: false, error: { ...this.#failure } };
    const capture = this.#captures.get(this.#key(ref));
    if (!capture)
      return { ok: false, error: { code: "not_started", message: "Recording does not exist." } };
    capture.state = "finished";
    return { ok: true, value: structuredClone(this.#video) };
  }
  async discard(ref: SandboxRecording): Promise<Result<void, DesktopError>> {
    this.calls.push({ ...ref, operation: "discard" });
    if (this.#failure) return { ok: false, error: { ...this.#failure } };
    this.#captures.delete(this.#key(ref));
    return { ok: true, value: undefined };
  }
}
