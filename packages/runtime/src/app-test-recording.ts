import { computerRecordingKey } from "@nap/shared/computer-artifacts";
import type { NapEventOf } from "@nap/shared/events";
import { getLogger } from "@nap/shared/logging";
import type { ObjectStore } from "@nap/shared/ports/object-store";
import type { DesktopError, SandboxDesktop } from "@nap/shared/ports/sandbox-desktop";
import type { SandboxRecording, SandboxRecordings } from "@nap/shared/ports/sandbox-recordings";
import type { TestRecordingState } from "@nap/shared/test-recording";
import { TurnAbortError } from "@nap/shared/turn-abort";

export type AppTestRecordingClock = () => Promise<number | null>;

/**
 * The desktop start script holds a lock for its whole run, so a second start waits for the first
 * and then finds it ready. The encoder has no such guard: a begin whose reply was lost may still
 * be spawning ffmpeg in the machine, and a second begin for the same recording would spawn
 * another. So only the start is retried, and never after a failure a retry cannot fix or that
 * already spent the transport's whole deadline.
 */
const DESKTOP_START_ATTEMPTS = 2;
const FINAL_START_FAILURES: ReadonlySet<DesktopError["code"]> = new Set([
  "cancelled",
  "outdated",
  "timeout",
]);

type CaptureStep = "desktop_start" | "encoder_warmup" | "recording_begin";
type StepFailure = { code?: DesktopError["code"]; error?: string; err?: unknown };

/**
 * Runs one capture step and logs its failure under the turn's context. A capture failure never
 * fails the test, so this line is the only place its step and code are kept.
 */
async function captureStep(
  step: CaptureStep,
  attempt: number,
  call: () => Promise<{ ok: true } | { ok: false; error: DesktopError }>,
): Promise<StepFailure | undefined> {
  const began = Date.now();
  let failure: StepFailure;
  try {
    const result = await call();
    if (result.ok) return undefined;
    failure = { code: result.error.code, error: result.error.message };
  } catch (err) {
    failure = { err };
  }
  getLogger().warn(
    { step, attempt, ...failure, elapsedMs: Date.now() - began },
    step === "encoder_warmup" ? "test recording warm-up failed" : "test recording could not start",
  );
  return failure;
}

/** True once the encoder has its first frame. */
async function beginCapture(
  options: {
    sandboxId: string;
    devServerUrl: string;
    desktop: Pick<SandboxDesktop, "start" | "screenshot">;
    signal?: AbortSignal | undefined;
  },
  recordings: SandboxRecordings,
  ref: SandboxRecording,
): Promise<boolean> {
  const signal = options.signal ? { signal: options.signal } : {};
  for (let attempt = 1; ; attempt++) {
    const failure = await captureStep("desktop_start", attempt, () =>
      options.desktop.start({
        sandboxId: options.sandboxId,
        devServerUrl: options.devServerUrl,
        ...signal,
      }),
    );
    if (!failure) break;
    if (
      attempt >= DESKTOP_START_ATTEMPTS ||
      options.signal?.aborted ||
      (failure.code !== undefined && FINAL_START_FAILURES.has(failure.code))
    )
      return false;
  }
  // A fresh VM pages programs in from a lazily loaded disk (start-desktop.sh), and the recorder
  // allows ffmpeg two seconds to appear and five to give a frame. Starting the desktop runs no
  // ffmpeg, so a test whose build turn never looked at the screen is ffmpeg's first run on the
  // machine, under that deadline. A screenshot runs the same binary and leaves no recording
  // state behind, so it pays most of that first load beforehand. A failed one is only logged.
  await captureStep("encoder_warmup", 1, () =>
    options.desktop.screenshot(options.sandboxId, options.signal),
  );
  return (
    (await captureStep("recording_begin", 1, () => recordings.begin({ ...ref, ...signal }))) ===
    undefined
  );
}

/** The test start is the deletion index even if capture or its upload announcement fails. */
export async function withAppTestRecording<T extends { ok: boolean }>(
  options: {
    projectId: string;
    sessionId: string;
    turnId: string;
    sandboxId: string;
    devServerUrl: string;
    started: NapEventOf<"test.started">["payload"];
    desktop: Pick<SandboxDesktop, "start" | "screenshot">;
    recordings?: SandboxRecordings | undefined;
    objects: ObjectStore;
    signal?: AbortSignal | undefined;
    emit: {
      (type: "test.started", payload: NapEventOf<"test.started">["payload"]): void;
      (type: "test.recording", payload: NapEventOf<"test.recording">["payload"]): void;
    };
    beforeCapture: () => Promise<void>;
  },
  run: (clock: AppTestRecordingClock | undefined) => Promise<T>,
): Promise<T> {
  options.emit("test.started", options.started);
  await options.beforeCapture();
  const recordings = options.recordings;
  if (!recordings) return run(undefined);
  const ref = { sandboxId: options.sandboxId, recordingId: options.turnId };
  let captured = false;
  let lostClock = false;
  let interrupted = true;
  const leaseLost = () =>
    options.signal?.reason instanceof TurnAbortError && options.signal.reason.leaseLost;
  try {
    captured = await beginCapture(options, recordings, ref);
    if (captured) options.emit("test.recording", { recording: { state: "started" } });
    const clock: AppTestRecordingClock = async () => {
      if (lostClock) return null;
      try {
        const result = await recordings.timestamp(ref);
        if (
          result.ok &&
          Number.isInteger(result.value) &&
          result.value >= 0 &&
          result.value <= 605_000
        )
          return result.value;
      } catch {
        /* A broken timeline must never be advertised as a playable test recording. */
      }
      lostClock = true;
      return null;
    };
    const outcome = await run(captured ? clock : undefined);
    interrupted = !outcome.ok || options.signal?.aborted === true;
    return outcome;
  } finally {
    let recording: TestRecordingState = { state: "unavailable", reason: "capture_failed" };
    if (captured) {
      // Finish has its own deadline; the turn's aborted signal must not cut off MP4 finalization.
      try {
        const clip = await recordings.finish(ref);
        if (leaseLost()) recording = { state: "unavailable", reason: "lease_lost" };
        else if (lostClock) recording = { state: "unavailable", reason: "timing_failed" };
        else if (clip.ok) {
          const key = computerRecordingKey(options);
          const stored = await options.objects.put(key, clip.value.bytes);
          recording = leaseLost()
            ? { state: "unavailable", reason: "lease_lost" }
            : stored.ok
              ? {
                  state: "available",
                  key,
                  durationMs: clip.value.durationMs,
                  width: clip.value.width,
                  height: clip.value.height,
                  interrupted,
                }
              : { state: "unavailable", reason: "upload_failed" };
        }
      } catch {
        /* Keep the test result when capture or storage is unavailable. */
      }
    }
    try {
      options.emit("test.recording", { recording });
    } finally {
      await recordings.discard(ref).catch(() => undefined);
    }
  }
}
